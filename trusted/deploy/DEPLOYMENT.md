# Deploying the omaCashu trusted device (operator guide)

This is a **prototype** setup for an experienced Linux operator. A misconfiguration defeats the isolation. Do not connect a funded wallet during the alpha.

Use a **separate physical device** (for example a Raspberry Pi or mini-PC with its own screen and keyboard), with full-disk encryption, automatic updates and a firewall or private VPN. The Omarchy computer must have **no** other login path to it: no admin SSH key, no remote desktop.

## 1. Accounts and code (trusted device, as root)

```bash
groupadd --system omacashu-requests
useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin --gid omacashu-requests omacashu-wallet
useradd --system --create-home --shell /usr/sbin/nologin --groups omacashu-requests omacashu-propose
passwd -l omacashu-propose

git clone https://github.com/yaeloss/omacashu.git /opt/omacashu
git -C /opt/omacashu checkout v0.1.0-alpha        # a reviewed tag, never a moving branch
chown -R root:root /opt/omacashu
chmod -R go-w /opt/omacashu
```

Neither account gets sudo rights. `omacashu-propose` must not be able to write its authorized keys, the bridge, or anything under `/opt/omacashu/trusted`.

## 2. Broker service

```bash
install -m 0644 /opt/omacashu/trusted/deploy/omacashu-broker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now omacashu-broker
systemd-analyze security omacashu-broker      # expect a low exposure score
ls -la /run/omacashu/                         # drwx--x--- omacashu-wallet omacashu-requests; requests.sock srw-rw----
```

The broker refuses to start if its state directory or database is a symlink, is not owned by the service user, or is group- or world-accessible. It also refuses if the socket directory is writable by others.

## 3. Restricted SSH ingress

```bash
install -d -m 0755 /etc/ssh/authorized_keys
install -m 0644 /dev/null /etc/ssh/authorized_keys/omacashu-propose
# paste ONE line based on deploy/authorized_keys.example
install -m 0644 /opt/omacashu/trusted/deploy/sshd_config.d/omacashu-propose.conf /etc/ssh/sshd_config.d/
sshd -t && systemctl reload sshd
sshd -T -C user=omacashu-propose,host=omarchy,addr=192.0.2.10 | grep -iE 'forcecommand|permittty|disableforwarding'
```

Also set these globally in `sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`, `MaxStartups 10:30:60` and `LoginGraceTime 20`.

**Verify from the Omarchy machine. Every one of these must fail:**

```bash
ssh -i ~/.ssh/omacashu-propose omacashu-propose@trusted 'id'            # forced command ignores it
ssh -t -i ~/.ssh/omacashu-propose omacashu-propose@trusted               # no TTY
ssh -N -L 8080:localhost:22 -i ~/.ssh/omacashu-propose omacashu-propose@trusted   # no forwarding
```

## 4. Omarchy client

On Omarchy, create a dedicated key and pin the trusted device's host key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/omacashu-propose -C omarchy-propose-only
# Get the host key fingerprint from the trusted device's OWN console: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh-keyscan -t ed25519 trusted.example > ~/.ssh/omacashu-known-hosts
ssh-keygen -lf ~/.ssh/omacashu-known-hosts      # must match the console fingerprint
```

Then use the client:

```bash
python3 client/omacashu_cli.py --host trusted.example --identity ~/.ssh/omacashu-propose \
  --known-hosts ~/.ssh/omacashu-known-hosts ping
printf '%s\n' 'lnbc...' | python3 client/omacashu_cli.py --host trusted.example \
  --identity ~/.ssh/omacashu-propose --known-hosts ~/.ssh/omacashu-known-hosts submit
```

The client ignores `~/.ssh/config` and the SSH agent, refuses unknown host keys and validates its arguments.

## 5. Review (trusted device console only)

```bash
sudo -u omacashu-wallet /usr/bin/python3 -I -B /opt/omacashu/trusted/bin/omacashu-review list
sudo -u omacashu-wallet /usr/bin/python3 -I -B /opt/omacashu/trusted/bin/omacashu-review reject <id>
```

Never run the review from an SSH session that started on Omarchy. **No payment is possible in this release.**
