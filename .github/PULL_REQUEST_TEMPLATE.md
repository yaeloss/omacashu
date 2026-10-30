## Summary

## Validation
- [ ] `python3 -m unittest discover -s tests -v`
- [ ] `(cd helper && npm ci && npm test)`
- [ ] `(cd trusted && python3 -m unittest discover -s tests -v)` if `trusted/` changed
- [ ] Tested on real Omarchy (all affected panel states; `omarchy restart shell` after QML changes)
- [ ] `preview.png` updated if the panel UI changed (real capture, test wallet only)

## Security impact
- [ ] QML still has only the helper socket and the fixed terminal launcher
- [ ] No secret, invoice or amount is logged or shown unverified; `STRICT_POLICY` unchanged
- [ ] New inputs bounded; negative tests added
- [ ] New dependencies exact-pinned, lockfile resolved with cooldown, audited

**Never include** real wallet connections or invoices in a PR.
