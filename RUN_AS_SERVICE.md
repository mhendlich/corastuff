# Running `serve.sh` as a background service

Use a user-level systemd service to keep `serve.sh` running after you disconnect (no `screen`/`tmux` required).

## Create the service unit
1) Pick the project path (example: `/root/coratest/corastuff`).  
2) Create `~/.config/systemd/user/corastuff.service` with:
```
[Unit]
Description=Corastuff server
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/coratest/corastuff            # update if your path differs
ExecStart=/bin/bash /root/coratest/corastuff/serve.sh # update if your path differs
Restart=on-failure
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
```
3) Make sure lingering is enabled so the user service keeps running after logout:  
`loginctl enable-linger "$(whoami)"`

## Start and enable
```
systemctl --user daemon-reload
systemctl --user enable --now corastuff.service
```
`enable --now` starts it immediately and on future logins/boots.

## Check status and logs
- Status: `systemctl --user status corastuff.service`
- Live logs: `journalctl --user -u corastuff.service -f`

## Shutdown and restart
- Stop: `systemctl --user stop corastuff.service`
- Restart (pick up code changes): `systemctl --user restart corastuff.service`

If you edit the unit file, run `systemctl --user daemon-reload` before restarting.

## Quick one-off (no systemd)
Use `nohup` to detach from your SSH session (does not auto-start after reboot):
- Start: `nohup ./serve.sh >/tmp/corastuff.log 2>&1 & echo $! >/tmp/corastuff.pid`
- Logs: `tail -f /tmp/corastuff.log`
- Stop: `kill "$(cat /tmp/corastuff.pid)"` (or `pkill -f corastuff/serve.sh`)
- Restart: stop, then run the start command again.
