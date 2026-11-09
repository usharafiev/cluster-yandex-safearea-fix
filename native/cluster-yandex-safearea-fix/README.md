# cluster-yandex-safearea-fix

A small reversible add-on tool for [waze-on-cluster](https://github.com/robertnisipeanu/idrive-apps)
on a BMW iDrive 7 head unit (MGU) that **sets the CarPlay instrument-cluster
safe area for Yandex Maps**.

CarPlay is iPhone-only, so this is for the **iOS** Yandex Maps app projected
over CarPlay — not Android Auto.

## What it does

waze-on-cluster advertises the cluster map and tells the phone a **safe area** —
the rectangle where the phone keeps its guidance UI (the next-turn banner) clear
of the gauges. Its default (x = 286) puts that banner in the wrong place for
**Yandex Maps**; this tool moves it to **504×368+433+72**, tuned for Yandex Maps.

**The safe area is one rectangle for every CarPlay app.** It is right for Yandex
Maps and **may misplace the banner on others** (Apple Maps, Google Maps, Waze).
Install it only if Yandex Maps is the navigator you use on the cluster.

## How it works — a thin wrapper, not its own patch

This tool does **not** edit carplay itself. It calls waze-on-cluster's own
patcher: it reads `carplay_patch.js status`, and, when the cluster map is
enabled on the high panel, runs

```
carplay_patch.js apply --panel high --safe 504x368+433+72
```

— the same 16 bytes waze-on-cluster would write, with **waze-on-cluster's own
locator and backup** (`carplay.woc-orig`). So this tool keeps **no locator and
no backup of its own**: there is nothing of ours to go stale.

waze-on-cluster writes its default safe area on every **Enable map** and resets
it on updates, so a small root **boot service** re-applies the Yandex offset
once after each start (`reconcile`). The change takes effect at the next
head-unit start, the same way waze-on-cluster works. It preserves a redirected
capture sink (the HUD/capture path is not reset), never stops, kills, restarts
or reboots carplay, and **never enables a map the owner turned off** — with the
map off it does nothing.

It **always exits 0**: if the offset cannot be written now (the map is off,
waze-on-cluster is not installed, carplay status is unreadable, `/` is not
writable), it logs the reason and leaves the next boot's reconcile to apply it,
so a Store install or update is never rolled back, and a removal is never
refused.

## The offset

Default: **504×368+433+72**. Change it without editing shipped files by writing
a line to `/var/opt/cluster-yandex-safearea-fix/safearea.local.conf`:

```
safe=504x368+433+72
```

(updates keep `safearea.local.conf`).

## Install and remove

Install **after** waze-on-cluster and enable its map first. The deploy tool runs
`safearead.js activate`; the Store shows a restart pending, and the safe area
takes effect at the next head-unit start. Remove it in the Store;
`safearead.js deactivate` runs `carplay_patch.js apply --panel high` with
waze-on-cluster's own default safe area (504×368+286+72), so the banner returns
to where waze-on-cluster puts it, with the map still on.

## Note

The same Yandex offset is baked into the **yandex-on-cluster** fork of
waze-on-cluster (its Enable map writes 433 by default), which needs no separate
tool. This tool is for a car running **upstream** waze-on-cluster.

## From a shell

```sh
node safearead.js activate      # set the Yandex safe area if the map is on
node safearead.js reconcile     # the boot service: re-apply if it was reset
node safearead.js deactivate    # restore waze-on-cluster's default safe area
```

## License

GPL-3.0-or-later (`LICENSE`).
