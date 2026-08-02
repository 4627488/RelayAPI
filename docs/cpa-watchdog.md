# CPA watchdog

`cliproxyapi` can become unavailable while its container is still running, so
Docker's restart policy alone cannot recover it. The production watchdog checks
RelayAPI's local health endpoint every 30 seconds and restarts only
`cliproxyapi` after two consecutive responses where CPA or the required bridge
is unhealthy.

Install the versioned files as root:

```sh
install -m 0755 deploy/relayapi-cpa-watchdog.sh /usr/local/sbin/relayapi-cpa-watchdog
install -m 0644 deploy/relayapi-cpa-watchdog.service /etc/systemd/system/relayapi-cpa-watchdog.service
install -m 0644 deploy/relayapi-cpa-watchdog.timer /etc/systemd/system/relayapi-cpa-watchdog.timer
systemctl daemon-reload
systemctl enable --now relayapi-cpa-watchdog.timer
```

Inspect recent decisions with:

```sh
journalctl -u relayapi-cpa-watchdog.service --since today
```

The check distinguishes CPA/bridge failures from database or subscription
health failures. A single transient failure is logged but does not restart the
container.
