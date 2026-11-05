# Chapter Skip for Jellyfin

Adds chapter navigation to Jellyfin's built-in comic/manga reader (`.cbz`, `.cbr`, `.cbt`, `.cb7`), for series where each chapter is its own file.

**What you get in the reader**
- Two new buttons in the bottom toolbar, next to the page arrows: ⏮ previous chapter, ⏭ next chapter (hover shows the chapter name).
- On the last page, a "End of chapter → Next chapter" card appears.
- Keyboard: `N` = next chapter, `P` = previous chapter. On the last page, pressing the "next page" arrow once more opens the next chapter (respects right-to-left mode).
- When you move on from the last page, the finished chapter is marked as read. (To turn this off, set `MARK_PLAYED_ON_FINISH = false` at the top of `chapterskip.js`.)

**How chapters are found:** the other book files in the same folder, sorted naturally by file name, so `Chapter 2.cbz` comes before `Chapter 10.cbz`. The next chapter always opens at page 1.

Written for the Jellyfin 10.11 web client. It only affects the web UI (browser, and desktop apps that use the web UI); native apps like Findroid or the Android TV app have their own readers.

---

## Option A — No build needed (easiest)

1. In Jellyfin, install the **JavaScript Injector** plugin (Dashboard → Plugins → Catalog; you may need to add its repository first, see https://github.com/n00bcodr/Jellyfin-JavaScript-Injector).
2. Restart Jellyfin, open the JavaScript Injector settings, add a new script, and paste the contents of `Jellyfin.Plugin.ChapterSkip/Web/chapterskip.js`.
3. Save, then hard-refresh the browser (Ctrl+Shift+R).

## Option B — Install as its own plugin

### Build
Needs the .NET 9 SDK:

```
dotnet publish Jellyfin.Plugin.ChapterSkip/Jellyfin.Plugin.ChapterSkip.csproj -c Release -o out
```

No .NET installed? Push this folder to a GitHub repo — the included workflow builds it, and the DLL appears under the run's **Artifacts**.

### Install
1. Create a folder `ChapterSkip_1.0.0.0` inside Jellyfin's `plugins` directory
   (e.g. `/config/plugins/` in Docker, `/var/lib/jellyfin/plugins/` on Debian/Ubuntu, `%PROGRAMDATA%\Jellyfin\Server\plugins\` on Windows).
2. Copy `Jellyfin.Plugin.ChapterSkip.dll` into it.
3. Restart Jellyfin, then hard-refresh the browser.

On startup the plugin adds the script to the web client's `index.html` (and removes it if you uninstall). **Jellyfin must be allowed to write that file.** If it can't, the server log will say so — this is common with the linuxserver.io Docker image. In that case use Option A instead.

After a Jellyfin update replaces the web client, the plugin re-adds the script on the next restart.

## Troubleshooting
- Open the browser console (F12): you should see `[ChapterSkip] loaded`.
- Buttons greyed out: there is no previous/next book file in the same folder, or that's the first/last chapter.
