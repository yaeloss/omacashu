pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// omaCashu panel.
//
// Talks ONLY to the omaCashu helper over its user-only socket
// ($XDG_RUNTIME_DIR/omacashu/helper.sock). The helper holds the wallet
// connection in the system keyring, verifies invoices and enforces the
// wallet budget. This panel never sees the credential, never parses
// invoices itself, and every payment needs a press-and-hold confirmation
// of helper-verified details. The only other capability is opening a
// terminal for fixed helper commands (install, connect, disconnect).
Panel {
  id: root
  moduleName: "io.github.yaeloss.omacashu"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color contentForeground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color contentDim: Qt.darker(contentForeground, 1.4)
  readonly property color warnColor: Commons.Color.urgent
  readonly property color accentColor: Commons.Color.accent
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  // ---- Paths. Launch buttons stay disabled unless every path is plain.
  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || ""
  readonly property string homeDir: Quickshell.env("HOME") || ""
  readonly property string helperSocketPath: runtimeDir + "/omacashu/helper.sock"
  readonly property string pluginDir: decodeURIComponent(String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "")).replace(/\/$/, "")
  readonly property bool pathsSafe: safePath(runtimeDir) && safePath(homeDir) && safePath(pluginDir)

  // ---- State
  // loading | helper_missing | not_connected | unreachable | unusable | ready | review | paying | result
  property string phase: "loading"
  readonly property bool settingUp: ["helper_missing", "not_connected", "unusable"].indexOf(phase) !== -1
  property bool showSettings: false
  property var helperStatus: null
  property var prepared: null
  property var payResult: null
  property string errorText: ""
  property bool busy: false
  property int now: Math.floor(Date.now() / 1000)

  readonly property bool reviewExpired: prepared !== null && now > prepared.confirm_by
  readonly property var budget: helperStatus && helperStatus.budget ? helperStatus.budget : null

  readonly property var glyphCodes: ({
    bolt: 0xF140B, cog: 0xF0493, wallet: 0xF0584, link: 0xF0337, info: 0xF02FD,
    chevron: 0xF0142, alert: 0xF0026, check: 0xF012C, close: 0xF0156, download: 0xF01DA, refresh: 0xF0450
  })

  readonly property bool alphaDismissed: settings && settings.alphaWarningDismissed === true

  function dismissAlphaWarning() {
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.alphaWarningDismissed = true
    root.settings = entry
    if (root.hostWidget) root.hostWidget.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function glyph(name) { return String.fromCodePoint(glyphCodes[name]) }
  function safePath(p) { return /^\/[A-Za-z0-9._\/-]+$/.test(p) }
  function sats(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " sats" }
  function shortKey(k) { return k && k.length > 20 ? k.slice(0, 10) + "…" + k.slice(-8) : (k || "") }
  function clock(seconds) {
    var s = Math.max(0, Math.floor(seconds))
    if (s >= 86400) return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h"
    if (s >= 3600) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0")
  }
  function renewText(b) {
    if (!b || !b.renews_at) return b && b.renewal_period && b.renewal_period !== "never" ? "renews " + b.renewal_period : "no renewal"
    var days = Math.ceil((b.renews_at - root.now) / 86400)
    return days <= 1 ? "renews within a day" : "renews in " + days + " days"
  }
  function failureText(r) {
    if (!r) return "No answer from the helper."
    if (r.error === "helper_unavailable") return "The omaCashu helper is not running."
    if (r.error === "timeout") return "No answer from the helper. Check your wallet before trying again."
    return r.message || "Request failed."
  }

  // ---- Helper client: one request at a time over the user-only socket.
  property var queue: []
  property var inflight: null

  function call(payload, timeoutMs, callback) {
    queue.push({ payload: payload, timeoutMs: timeoutMs, callback: callback })
    pump()
  }

  function pump() {
    if (inflight || queue.length === 0) return
    inflight = queue.shift()
    requestTimer.interval = inflight.timeoutMs
    requestTimer.restart()
    helperSocket.connected = true
  }

  function finish(response) {
    var current = inflight
    inflight = null
    requestTimer.stop()
    helperSocket.connected = false
    if (current) current.callback(response)
    Qt.callLater(root.pump)
  }

  Socket {
    id: helperSocket
    path: root.helperSocketPath
    parser: SplitParser {
      onRead: function(line) {
        var response = null
        try { response = JSON.parse(line) } catch (e) { response = null }
        root.finish(response && typeof response === "object" ? response : { ok: false, error: "helper_unavailable" })
      }
    }
    onConnectedChanged: {
      if (connected && root.inflight) {
        write(JSON.stringify(root.inflight.payload) + "\n")
        flush()
      }
    }
    onError: function(error) {
      if (root.inflight) root.finish({ ok: false, error: "helper_unavailable" })
    }
  }

  Timer {
    id: requestTimer
    repeat: false
    onTriggered: if (root.inflight) root.finish({ ok: false, error: "timeout" })
  }

  Timer {
    interval: 30000
    repeat: true
    running: root.opened && ["review", "paying", "result"].indexOf(root.phase) === -1
    onTriggered: root.refreshStatus()
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.opened && (root.phase === "review" || root.phase === "ready")
    onTriggered: root.now = Math.floor(Date.now() / 1000)
  }

  // ---- Actions
  function refreshStatus() {
    call({ op: "status" }, 20000, function(r) {
      var settled = ["review", "paying", "result"].indexOf(root.phase) !== -1
      if (!r || !r.ok) {
        root.helperStatus = null
        if (!settled) root.phase = "helper_missing"
        return
      }
      root.helperStatus = r
      if (settled) return
      var previous = root.phase
      if (!r.connected) root.phase = "not_connected"
      else if (!r.reachable) root.phase = "unreachable"
      else if (!r.usable) root.phase = "unusable"
      else root.phase = "ready"
      if (root.phase === "ready" && previous !== "ready" && root.opened) Qt.callLater(root.focusInvoice)
    })
  }

  function focusInvoice() {
    if (root.opened && root.phase === "ready") invoiceField.forceActiveFocus()
  }

  function review() {
    var text = invoiceField.text.trim()
    if (text === "" || root.busy) return
    root.errorText = ""
    root.busy = true
    call({ op: "prepare", invoice: text }, 30000, function(r) {
      root.busy = false
      if (r && r.ok) {
        root.prepared = r
        invoiceField.text = ""
        root.now = Math.floor(Date.now() / 1000)
        root.phase = "review"
        Qt.callLater(function() { if (root.phase === "review") holdButton.forceActiveFocus() })
      } else {
        root.errorText = root.failureText(r)
      }
    })
  }

  function pay() {
    if (!root.prepared || root.phase !== "review" || root.reviewExpired) return
    var paymentId = root.prepared.payment_id
    root.phase = "paying"
    call({ op: "confirm", payment_id: paymentId }, 95000, function(r) {
      root.payResult = r && typeof r === "object" ? r : { ok: false, error: "timeout" }
      root.prepared = null
      root.phase = "result"
    })
  }

  function cancelReview() {
    if (root.prepared) call({ op: "cancel", payment_id: root.prepared.payment_id }, 5000, function(r) {})
    root.prepared = null
    root.phase = "ready"
    Qt.callLater(root.focusInvoice)
    refreshStatus()
  }

  function finishResult() {
    root.payResult = null
    root.phase = "ready"
    Qt.callLater(root.focusInvoice)
    refreshStatus()
  }

  function launchInTerminal(command) {
    if (!root.pathsSafe) return
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation", command])
    root.close()
  }
  function installHelper() { launchInTerminal("bash '" + root.pluginDir + "/helper/install.sh'") }
  function connectWallet() { launchInTerminal("'" + root.homeDir + "/.local/bin/omacashu' connect") }
  function disconnectWallet() { launchInTerminal("'" + root.homeDir + "/.local/bin/omacashu' disconnect") }

  // ---- Panel lifecycle
  function open() {
    root.controller.show()
    root.now = Math.floor(Date.now() / 1000)
    if (root.phase === "ready") Qt.callLater(root.focusInvoice)
    if (root.phase !== "paying") refreshStatus()
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    if (root.phase === "review") cancelReview()
    if (root.phase === "result") finishResult()
    root.showSettings = false
    root.errorText = ""
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  // ---- Reusable pieces
  component StateBlock: Column {
    id: block
    property string icon: ""
    property string title: ""
    property string body: ""
    property string actionText: ""
    property string actionIcon: ""
    property bool actionEnabled: true
    property color fg: Commons.Color.foreground
    property color iconColor: Qt.darker(fg, 1.25)
    property string family: Style.font.family
    signal action()

    spacing: Style.space(8)

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      textFormat: Text.PlainText
      text: block.icon
      color: block.iconColor
      font.family: block.family
      font.pixelSize: Math.round(Style.font.displayLarge * 1.5)
    }
    Text {
      width: parent.width
      horizontalAlignment: Text.AlignHCenter
      textFormat: Text.PlainText
      text: block.title
      color: block.fg
      font.family: block.family
      font.pixelSize: Style.font.heading
      font.bold: true
      wrapMode: Text.WordWrap
    }
    Text {
      width: parent.width
      horizontalAlignment: Text.AlignHCenter
      textFormat: Text.PlainText
      text: block.body
      visible: text !== ""
      color: Qt.darker(block.fg, 1.4)
      font.family: block.family
      font.pixelSize: Style.font.body
      wrapMode: Text.WordWrap
    }
    Item { width: 1; height: Style.space(4) }
    Button {
      width: parent.width
      visible: block.actionText !== ""
      enabled: block.actionEnabled
      opacity: enabled ? 1 : 0.5
      bordered: true
      text: block.actionText
      iconText: block.actionIcon
      foreground: block.fg
      fontFamily: block.family
      verticalPadding: Style.space(8)
      onClicked: block.action()
    }
  }

  component InfoRow: Item {
    id: infoRow
    property string label: ""
    property string value: ""
    property color fg: Commons.Color.foreground
    property string family: Style.font.family
    width: parent ? parent.width : 0
    implicitHeight: Math.max(labelText.implicitHeight, valueText.implicitHeight)
    Text {
      id: labelText
      anchors.left: parent.left
      textFormat: Text.PlainText
      text: infoRow.label
      color: Qt.darker(infoRow.fg, 1.4)
      font.family: infoRow.family
      font.pixelSize: Style.font.body
    }
    Text {
      id: valueText
      anchors.right: parent.right
      width: Math.min(implicitWidth, parent.width - labelText.width - Style.space(12))
      horizontalAlignment: Text.AlignRight
      textFormat: Text.PlainText
      text: infoRow.value
      color: infoRow.fg
      font.family: infoRow.family
      font.pixelSize: Style.font.body
      elide: Text.ElideMiddle
    }
  }

  component HoldButton: Item {
    id: hold
    property string text: ""
    property color fg: Commons.Color.foreground
    property color fill: Commons.Color.accent
    property string family: Style.font.family
    property int holdMs: 1500
    property real progress: 0
    signal confirmed()

    implicitHeight: Style.space(42)
    opacity: enabled ? 1 : 0.45
    activeFocusOnTab: false

    function begin() { holdAnimation.stop(); hold.progress = 0; holdAnimation.start() }
    function abort() { if (hold.progress < 1) { holdAnimation.stop(); hold.progress = 0 } }

    // Keyboard alternative: hold Space. Auto-repeat events are ignored, so only a
    // deliberate, continuous 1.5 s hold confirms.
    Keys.onPressed: function(event) {
      if (event.key === Qt.Key_Space) {
        event.accepted = true
        if (!event.isAutoRepeat && hold.enabled) hold.begin()
      }
    }
    Keys.onReleased: function(event) {
      if (event.key === Qt.Key_Space) {
        event.accepted = true
        if (!event.isAutoRepeat) hold.abort()
      }
    }
    onActiveFocusChanged: if (!activeFocus) hold.abort()

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: Qt.rgba(hold.fill.r, hold.fill.g, hold.fill.b, 0.08)
      border.width: hold.activeFocus ? 2 : 1
      border.color: hold.fill
    }
    Rectangle {
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      anchors.margins: 1
      width: Math.max(0, (parent.width - 2) * hold.progress)
      radius: Style.cornerRadius
      color: Qt.rgba(hold.fill.r, hold.fill.g, hold.fill.b, 0.4)
    }
    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: hold.text
      color: hold.fg
      font.family: hold.family
      font.pixelSize: Style.font.subtitle
      font.bold: true
    }
    NumberAnimation {
      id: holdAnimation
      target: hold
      property: "progress"
      from: 0
      to: 1
      duration: hold.holdMs
      onFinished: if (hold.progress >= 1) hold.confirmed()
    }
    MouseArea {
      anchors.fill: parent
      enabled: hold.enabled
      cursorShape: Qt.PointingHandCursor
      onPressed: hold.begin()
      onReleased: hold.abort()
      onCanceled: { holdAnimation.stop(); hold.progress = 0 }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: invoiceField.activeFocus
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(14)

        // ---- Header: bolt, name, settings
        Item {
          width: parent.width
          implicitHeight: Math.max(headerIcon.implicitHeight, settingsButton.implicitHeight)

          Text {
            id: headerIcon
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.glyph("bolt")
            color: root.accentColor
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.display
          }
          Text {
            anchors.left: headerIcon.right
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: "omaCashu"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.heading
            font.bold: true
          }
          PanelActionButton {
            id: settingsButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: root.showSettings ? root.glyph("close") : root.glyph("cog")
            tooltipText: root.showSettings ? "Back" : "Wallet and helper settings"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: root.showSettings = !root.showSettings
          }
        }

        // ---- Alpha banner: dismissal is stored in the shell widget settings.
        Rectangle {
          visible: !root.alphaDismissed
          width: parent.width
          implicitHeight: bannerRow.implicitHeight + Style.space(20)
          radius: Style.cornerRadius
          color: Qt.rgba(root.warnColor.r, root.warnColor.g, root.warnColor.b, 0.14)
          border.width: 1
          border.color: Qt.rgba(root.warnColor.r, root.warnColor.g, root.warnColor.b, 0.6)

          Row {
            id: bannerRow
            x: Style.space(12)
            y: Style.space(10)
            width: parent.width - Style.space(24)
            spacing: Style.space(10)

            Text {
              id: bannerIcon
              textFormat: Text.PlainText
              text: root.glyph("alert")
              color: root.warnColor
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.iconLarge
            }
            Column {
              width: parent.width - bannerIcon.width - dismissAlphaButton.width - 2 * parent.spacing
              spacing: Style.space(2)
              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: "ALPHA · LIVE PAYMENTS"
                color: root.warnColor
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.body
                font.bold: true
                font.letterSpacing: 1
              }
              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: "Experimental software. Use only a small, budget-limited wallet connection."
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.body
                wrapMode: Text.WordWrap
              }
            }
            PanelActionButton {
              id: dismissAlphaButton
              focusable: true
              iconText: root.glyph("close")
              tooltipText: "Dismiss alpha warning"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: root.dismissAlphaWarning()
            }
          }
        }

        PanelSeparator { foreground: root.contentForeground }

        // ---- Main area (one block visible at a time)
        Column {
          width: parent.width
          spacing: Style.space(12)
          visible: !root.showSettings

          Text {
            width: parent.width
            visible: root.phase === "loading"
            horizontalAlignment: Text.AlignHCenter
            textFormat: Text.PlainText
            text: "Checking the omaCashu helper…"
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
          }

          Text {
            width: parent.width
            visible: root.settingUp
            textFormat: Text.PlainText
            text: root.phase === "helper_missing"
              ? "SETUP  1 / 3 · Install helper"
              : "SETUP  2 / 3 · Connect wallet"
            color: root.accentColor
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
            font.bold: true
            wrapMode: Text.WordWrap
          }

          StateBlock {
            width: parent.width
            visible: root.phase === "helper_missing"
            fg: root.contentForeground
            family: root.contentFontFamily
            icon: root.glyph("wallet")
            title: "Set up omaCashu"
            body: "First, install the helper that keeps your wallet connection in the system keyring. You need Node.js 22+, npm and an unlocked system keyring. The installer opens in a terminal and explains anything missing. When it finishes, reopen this panel for step 2."
            actionText: "Install helper"
            actionIcon: root.glyph("download")
            actionEnabled: root.pathsSafe
            onAction: root.installHelper()
          }

          StateBlock {
            width: parent.width
            visible: root.phase === "not_connected"
            fg: root.contentForeground
            family: root.contentFontFamily
            icon: root.glyph("wallet")
            title: "Prepare your wallet connection"
            body: "In your wallet, create a new Nostr Wallet Connect connection just for omaCashu. Enable paying invoices and reading the budget. Set a small spending budget, such as 1,000 sats for your first test.\n\nYour wallet must support NWC budgets; not every Lightning or Cashu wallet does. Have the connection string ready, then continue."
            actionText: "Continue in secure prompt"
            actionIcon: root.glyph("link")
            actionEnabled: root.pathsSafe
            onAction: root.connectWallet()
          }

          StateBlock {
            width: parent.width
            visible: root.phase === "unreachable"
            fg: root.contentForeground
            family: root.contentFontFamily
            icon: root.glyph("wallet")
            title: "Wallet unreachable"
            body: "The helper could not reach your wallet. Check your network connection."
            actionText: "Try again"
            actionIcon: root.glyph("refresh")
            onAction: root.refreshStatus()
          }

          StateBlock {
            width: parent.width
            visible: root.phase === "unusable"
            fg: root.contentForeground
            family: root.contentFontFamily
            icon: root.glyph("alert")
            iconColor: root.warnColor
            title: "Connection not allowed"
            body: root.helperStatus && root.helperStatus.problems ? root.helperStatus.problems.join("\n") : ""
            actionText: "Connect a budget-limited wallet"
            actionIcon: root.glyph("link")
            actionEnabled: root.pathsSafe
            onAction: root.connectWallet()
          }

          Text {
            width: parent.width
            visible: root.phase === "not_connected" || root.phase === "unusable"
            textFormat: Text.PlainText
            text: "Paste the connection only into the helper's hidden terminal prompt. Review the budget and type yes to save. Then reopen this panel for step 3. Use only a dedicated wallet connection."
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }
          Button {
            width: parent.width
            visible: root.settingUp
            enabled: !root.busy
            text: "I've finished — check setup"
            iconText: root.glyph("refresh")
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: root.refreshStatus()
          }
          Text {
            width: parent.width
            visible: root.phase === "ready"
            textFormat: Text.PlainText
            text: "READY · 3 / 3 · Paste an invoice, review, then hold to pay"
            color: root.accentColor
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          // Ready: budget + invoice entry
          Column {
            width: parent.width
            spacing: Style.space(10)
            visible: root.phase === "ready"

            Item {
              width: parent.width
              implicitHeight: walletIcon.implicitHeight

              Text {
                id: walletIcon
                anchors.left: parent.left
                textFormat: Text.PlainText
                text: root.glyph("wallet")
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.display
              }
              Column {
                anchors.left: walletIcon.right
                anchors.leftMargin: Style.space(10)
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)
                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: root.helperStatus && root.helperStatus.alias ? root.helperStatus.alias : "Connected wallet"
                  color: root.contentForeground
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.subtitle
                  font.bold: true
                  elide: Text.ElideRight
                }
                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: root.budget ? root.sats(root.budget.remaining_sat) + " left of " + root.sats(root.budget.total_sat) + " budget" : ""
                  color: root.contentDim
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                }
              }
            }

            Rectangle {
              width: parent.width
              height: Style.space(4)
              radius: height / 2
              color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.12)
              Rectangle {
                height: parent.height
                radius: parent.radius
                width: root.budget && root.budget.total_sat > 0 ? parent.width * Math.min(1, root.budget.used_sat / root.budget.total_sat) : 0
                color: root.accentColor
              }
            }

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: root.budget ? root.sats(root.budget.used_sat) + " spent · " + root.renewText(root.budget) : ""
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }

            TextField {
              id: invoiceField
              width: parent.width
              placeholderText: "Paste a Lightning invoice (lnbc…)"
              foreground: root.contentForeground
              font.family: root.contentFontFamily
              enabled: !root.busy
              onTextChanged: root.errorText = ""
              Keys.onReturnPressed: root.review()
              Keys.onEnterPressed: root.review()
              Keys.onEscapePressed: root.close()
            }

            Text {
              width: parent.width
              visible: root.errorText !== ""
              textFormat: Text.PlainText
              text: root.errorText
              color: root.warnColor
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            Button {
              width: parent.width
              bordered: true
              enabled: !root.busy && invoiceField.text.trim() !== ""
              opacity: enabled ? 1 : 0.5
              text: root.busy ? "Checking invoice…" : "Review payment"
              iconText: root.glyph("bolt")
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              verticalPadding: Style.space(8)
              onClicked: root.review()
            }
          }

          // Review: helper-verified details + hold to pay
          Column {
            width: parent.width
            spacing: Style.space(10)
            visible: root.phase === "review" && root.prepared !== null

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: "PAY"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 2
            }
            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: root.prepared ? root.sats(root.prepared.amount_sat) : ""
              color: root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Math.round(Style.font.displayLarge * 1.2)
              font.bold: true
            }
            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: root.prepared && root.prepared.description ? "“" + root.prepared.description + "”"
                : (root.prepared && root.prepared.description_hash_only ? "(description provided as a hash)" : "(no description)")
              color: root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }
            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: "Description comes from the invoice and is not verified."
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            PanelSeparator { foreground: root.contentForeground }

            InfoRow {
              label: "Recipient node"
              value: root.prepared ? root.shortKey(root.prepared.payee) : ""
              fg: root.contentForeground
              family: root.contentFontFamily
            }
            InfoRow {
              label: "Invoice expires in"
              value: root.prepared ? root.clock(root.prepared.expires_at - root.now) : ""
              fg: root.contentForeground
              family: root.contentFontFamily
            }
            InfoRow {
              label: "Budget left after"
              value: root.prepared && root.prepared.budget_remaining_after_sat !== null ? root.sats(root.prepared.budget_remaining_after_sat) : "unknown"
              fg: root.contentForeground
              family: root.contentFontFamily
            }
            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: "Routing fees are paid from the same wallet budget. Signature, network, amount and expiry were verified by the helper."
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            HoldButton {
              id: holdButton
              width: parent.width
              enabled: !root.reviewExpired
              text: root.reviewExpired ? "Confirmation expired" : "Hold to pay " + (root.prepared ? root.sats(root.prepared.amount_sat) : "")
              fg: root.contentForeground
              fill: root.accentColor
              family: root.contentFontFamily
              onConfirmed: root.pay()
            }
            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: root.reviewExpired ? "Review the invoice again to pay it."
                : "Press and hold, or hold Space · confirm within " + (root.prepared ? root.clock(root.prepared.confirm_by - root.now) : "")
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }
            Button {
              width: parent.width
              text: "Cancel"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              onClicked: root.cancelReview()
            }
          }

          StateBlock {
            width: parent.width
            visible: root.phase === "paying"
            fg: root.contentForeground
            family: root.contentFontFamily
            icon: root.glyph("bolt")
            iconColor: root.accentColor
            title: "Paying…"
            body: "Waiting for your wallet. This can take up to a minute."
          }

          StateBlock {
            width: parent.width
            visible: root.phase === "result" && root.payResult !== null && root.payResult.ok === true
            fg: root.contentForeground
            family: root.contentFontFamily
            icon: root.glyph("check")
            iconColor: root.accentColor
            title: root.payResult && root.payResult.ok ? "Paid " + root.sats(root.payResult.amount_sat) : ""
            body: root.payResult && root.payResult.fee_sat !== null && root.payResult.fee_sat !== undefined ? "Routing fee " + root.sats(root.payResult.fee_sat) : "Payment confirmed by proof of payment."
            actionText: "Done"
            onAction: root.finishResult()
          }

          StateBlock {
            width: parent.width
            visible: root.phase === "result" && root.payResult !== null && root.payResult.ok !== true
            fg: root.contentForeground
            family: root.contentFontFamily
            icon: root.glyph("alert")
            iconColor: root.warnColor
            title: root.payResult && root.payResult.status === "failed" ? "Payment failed" : "Payment status unknown"
            body: root.failureText(root.payResult)
            actionText: "Done"
            onAction: root.finishResult()
          }
        }

        // ---- Settings
        Column {
          width: parent.width
          spacing: Style.space(10)
          visible: root.showSettings

          PanelSectionHeader {
            width: parent.width
            text: "WALLET"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
          }
          InfoRow {
            label: "Connection"
            value: !root.helperStatus ? "unknown" : (!root.helperStatus.connected ? "not connected"
              : (root.helperStatus.alias ? root.helperStatus.alias : "connected") + (root.helperStatus.usable === false ? " (blocked)" : ""))
            fg: root.contentForeground
            family: root.contentFontFamily
          }
          InfoRow {
            label: "Budget"
            value: root.budget ? root.sats(root.budget.used_sat) + " of " + root.sats(root.budget.total_sat) : "none"
            fg: root.contentForeground
            family: root.contentFontFamily
          }
          InfoRow {
            label: "Payments allowed on"
            value: root.helperStatus ? root.helperStatus.mode + " · max budget " + root.sats(root.helperStatus.ceiling_sat) : "unknown"
            fg: root.contentForeground
            family: root.contentFontFamily
          }
          Button {
            width: parent.width
            visible: root.helperStatus !== null
            enabled: root.pathsSafe
            bordered: true
            text: root.helperStatus && root.helperStatus.connected ? "Connect a different wallet" : "Connect wallet"
            iconText: root.glyph("link")
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: root.connectWallet()
          }
          Button {
            width: parent.width
            visible: root.helperStatus !== null && root.helperStatus.connected === true
            enabled: root.pathsSafe
            text: "Disconnect wallet"
            iconText: root.glyph("close")
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: root.disconnectWallet()
          }

          PanelSectionHeader {
            width: parent.width
            text: "HELPER"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
          }
          InfoRow {
            label: "Status"
            value: root.helperStatus ? "running · v" + root.helperStatus.version : "not running"
            fg: root.contentForeground
            family: root.contentFontFamily
          }
          Button {
            width: parent.width
            enabled: root.pathsSafe
            text: root.helperStatus ? "Update helper" : "Install helper"
            iconText: root.glyph("download")
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            onClicked: root.installHelper()
          }
          Text {
            width: parent.width
            textFormat: Text.PlainText
            text: "Your wallet connection lives in the system keyring, never in this plugin. Anything running as your user could spend up to the wallet budget, so keep it small."
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        PanelSeparator { foreground: root.contentForeground }

        // ---- Footer
        Item {
          width: parent.width
          implicitHeight: footerText.implicitHeight + Style.space(4)

          Text {
            id: footerIcon
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.glyph("info")
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.icon
          }
          Text {
            id: footerText
            anchors.left: footerIcon.right
            anchors.leftMargin: Style.space(8)
            anchors.right: footerChevron.left
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.phase === "ready" || root.phase === "review" || root.phase === "paying" || root.phase === "result"
              ? (root.budget ? "Live payments · " + root.sats(root.budget.remaining_sat) + " budget left" : "Live payments")
              : (root.phase === "unusable" ? "Payments blocked" : "No live payments")
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }
          Text {
            id: footerChevron
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.glyph("chevron")
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.icon
            rotation: root.showSettings ? 90 : 0
          }
          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: root.showSettings = !root.showSettings
          }
        }
      }
    }
  }
}
