/*
 * Chapter Skip for Jellyfin's comic/manga reader (.cbz/.cbr/.cbt/.cb7)
 *
 * Adds "previous chapter" / "next chapter" buttons to the reader's bottom bar and
 * shows a "Next chapter" card when you reach the last page of a chapter.
 * A "chapter" is any other book file in the same folder, sorted naturally by
 * file name (Chapter 2 comes before Chapter 10).
 *
 * Keyboard (while the reader is open): N = next chapter, P = previous chapter.
 * At the last page, pressing the "next page" arrow key once more also opens the next chapter.
 */
(function () {
    'use strict';

    if (window.__chapterSkipLoaded) return;
    window.__chapterSkipLoaded = true;

    // Mark a chapter as read when you move on from its last page.
    var MARK_PLAYED_ON_FINISH = true;

    var LOG = '[ChapterSkip]';
    var DOWNLOAD_RE = /\/Items\/([0-9a-fA-F-]{32,36})\/Download/i;
    var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    var lastDownloadedItemId = null;
    var siblingCache = {};
    var busy = false;

    // ---------------------------------------------------------------------------
    // 1. Learn which book the reader opened. The comics reader downloads the
    //    archive with fetch('/Items/<id>/Download'), so we watch for that URL.
    // ---------------------------------------------------------------------------
    var originalFetch = window.fetch;
    window.fetch = function (input) {
        try {
            var url = typeof input === 'string' ? input : (input && input.url) || String(input);
            var m = DOWNLOAD_RE.exec(url);
            if (m) lastDownloadedItemId = m[1].replace(/-/g, '').toLowerCase();
        } catch (e) { /* ignore */ }
        return originalFetch.apply(this, arguments);
    };

    // ---------------------------------------------------------------------------
    // 2. Server helpers (uses the web client's own logged-in ApiClient)
    // ---------------------------------------------------------------------------
    function client() {
        return window.ApiClient;
    }

    function getJson(path, params) {
        var c = client();
        return c.getJSON(c.getUrl(path, params));
    }

    function post(path, params) {
        var c = client();
        return c.ajax({ type: 'POST', url: c.getUrl(path, params) });
    }

    // Try the current (10.9+) route first, then the older /Users/{id}/... route.
    function firstThatWorks(attempts) {
        var i = 0;
        function next(err) {
            if (i >= attempts.length) return Promise.reject(err);
            var attempt = attempts[i++];
            return attempt().catch(next);
        }
        return next();
    }

    function fileName(item) {
        if (item.Path) {
            var parts = item.Path.split(/[\\/]/);
            return parts[parts.length - 1];
        }
        return item.SortName || item.Name || '';
    }

    function getChapters(itemId) {
        if (siblingCache[itemId]) return Promise.resolve(siblingCache[itemId]);

        var userId = client().getCurrentUserId();

        return firstThatWorks([
            function () { return getJson('Items/' + itemId, { userId: userId }); },
            function () { return getJson('Users/' + userId + '/Items/' + itemId); }
        ]).then(function (item) {
            var query = {
                ParentId: item.ParentId,
                IncludeItemTypes: 'Book',
                Recursive: false,
                Fields: 'Path,SortName',
                SortBy: 'SortName',
                SortOrder: 'Ascending',
                EnableImages: false,
                EnableTotalRecordCount: false
            };
            return firstThatWorks([
                function () { return getJson('Items', Object.assign({ userId: userId }, query)); },
                function () { return getJson('Users/' + userId + '/Items', query); }
            ]);
        }).then(function (result) {
            var items = (result.Items || []).slice();
            items.sort(function (a, b) { return collator.compare(fileName(a), fileName(b)); });

            var index = -1;
            for (var i = 0; i < items.length; i++) {
                if (items[i].Id.replace(/-/g, '').toLowerCase() === itemId) { index = i; break; }
            }

            var info = {
                prev: index > 0 ? items[index - 1] : null,
                next: index >= 0 && index < items.length - 1 ? items[index + 1] : null,
                index: index,
                total: items.length
            };
            siblingCache[itemId] = info;
            return info;
        });
    }

    function markPlayed(itemId) {
        var userId = client().getCurrentUserId();
        return firstThatWorks([
            function () { return post('UserPlayedItems/' + itemId, { userId: userId }); },
            function () { return post('Users/' + userId + '/PlayedItems/' + itemId); }
        ]).catch(function (e) { console.warn(LOG, 'could not mark as read', e); });
    }

    function readerIsOpen() {
        return !!document.getElementById('comicsPlayer');
    }

    // Method 1: start reading the same way a "Play" button on an item card does.
    // We build a hidden card inside one of the web client's own item containers and
    // click its play action, so the web client's own playback code opens the reader.
    function playLikeACard(item, serverId) {
        var host = document.createElement('div');
        host.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;';
        document.body.appendChild(host);
        host.innerHTML = '<div is="emby-itemscontainer" data-contextmenu="false">'
            + '<button type="button" class="itemAction" data-action="play"></button></div>';
        var container = host.firstElementChild;
        var button = container.firstElementChild;
        button.setAttribute('data-id', item.Id);
        button.setAttribute('data-serverid', serverId);
        button.setAttribute('data-type', item.Type || 'Book');
        button.setAttribute('data-mediatype', item.MediaType || 'Book');
        button.setAttribute('data-isfolder', 'false');
        button.setAttribute('data-positionticks', '0');

        // The web client adds the "itemsContainer" class once it has taken over the element.
        return waitFor(function () { return container.classList.contains('itemsContainer'); }, 3000, 25)
            .then(function (ready) {
                if (!ready) throw new Error('item container was not set up by the web client');
                return new Promise(function (r) { setTimeout(r, 50); });
            })
            .then(function () {
                button.click();
                return waitFor(readerIsOpen, 8000, 100);
            })
            .then(function (opened) {
                setTimeout(function () { host.remove(); }, 500);
                if (!opened) throw new Error('reader did not open after clicking play');
            }, function (e) {
                host.remove();
                throw e;
            });
    }

    // Method 2: ask the server to tell this browser to start reading
    // (the "remote control" route; needs a working websocket connection).
    function playViaServer(item) {
        var c = client();
        return getJson('Sessions', { deviceId: c.deviceId() }).then(function (sessions) {
            if (!sessions || !sessions.length) throw new Error('own session not found');
            return post('Sessions/' + sessions[0].Id + '/Playing', {
                playCommand: 'PlayNow',
                itemIds: item.Id,
                startPositionTicks: 0
            });
        }).then(function () {
            return waitFor(readerIsOpen, 6000, 100);
        }).then(function (opened) {
            if (!opened) throw new Error('reader did not open after server play command');
        });
    }

    function openInReader(item) {
        var c = client();
        var serverId = item.ServerId || c.serverId();
        console.log(LOG, 'opening', item.Name, item.Id);

        return playLikeACard(item, serverId)
            .catch(function (e) {
                console.warn(LOG, 'method 1 failed:', e && e.message, '- trying server play command');
                return playViaServer(item);
            })
            .catch(function (e) {
                console.warn(LOG, 'method 2 failed:', e && e.message, '- opening the chapter page instead');
                if (window.Emby && window.Emby.Page && window.Emby.Page.showItem) {
                    window.Emby.Page.showItem(item.Id, serverId);
                } else {
                    window.location.hash = '#/details?id=' + item.Id + '&serverId=' + serverId;
                }
            });
    }

    // ---------------------------------------------------------------------------
    // 3. Reader control
    // ---------------------------------------------------------------------------
    function waitFor(check, timeoutMs, intervalMs) {
        return new Promise(function (resolve) {
            var start = Date.now();
            (function poll() {
                var value = check();
                if (value || Date.now() - start > timeoutMs) return resolve(value);
                setTimeout(poll, intervalMs || 100);
            })();
        });
    }

    function closeReader(player) {
        // The first button in the top bar is the reader's own "Back" button.
        var back = player.querySelector('.bookOsd .bookOsdRow button');
        if (back) {
            back.click();
        } else {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        return waitFor(function () { return !document.body.contains(player); }, 4000)
            .then(function () { return new Promise(function (r) { setTimeout(r, 600); }); });
    }

    function goToChapter(player, state, target, isForward) {
        if (busy || !target) return;
        busy = true;
        var finished = isForward && state.swiper && state.swiper.isEnd;

        closeReader(player)
            .then(function () {
                if (finished && MARK_PLAYED_ON_FINISH) return markPlayed(state.itemId);
            })
            .then(function () { return openInReader(target); })
            .catch(function (e) { console.error(LOG, e); })
            .then(function () { busy = false; });
    }

    // ---------------------------------------------------------------------------
    // 4. UI
    // ---------------------------------------------------------------------------
    function injectStyles() {
        if (document.getElementById('chapterSkipStyles')) return;
        var style = document.createElement('style');
        style.id = 'chapterSkipStyles';
        style.textContent = [
            '.chapterSkipBtn[disabled]{opacity:.3;}',
            '.chapterSkipCard{position:absolute;left:50%;bottom:calc(5vh + 1.5em);transform:translateX(-50%);',
            '  z-index:1003;display:flex;align-items:center;gap:1em;padding:.8em 1em .8em 1.2em;max-width:90vw;',
            '  border-radius:.6em;background:rgba(20,20,20,.92);color:#fff;box-shadow:0 4px 20px rgba(0,0,0,.5);',
            '  font-size:1rem;transition:opacity .2s;}',
            '.chapterSkipCard.hide{opacity:0;pointer-events:none;}',
            '.chapterSkipCard .chapterSkipText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.chapterSkipCard .chapterSkipText small{display:block;opacity:.7;font-size:.8em;}',
            '.chapterSkipCard .chapterSkipGo{flex-shrink:0;border:0;border-radius:.4em;padding:.6em 1em;cursor:pointer;',
            '  font:inherit;font-weight:600;background:#00a4dc;color:#fff;}',
            '.chapterSkipCard .chapterSkipClose{flex-shrink:0;border:0;background:none;color:#fff;opacity:.7;cursor:pointer;font-size:1.3em;}',
            '@media (orientation: landscape) and (max-width: 60em){.chapterSkipCard{bottom:calc(10vh + 1em);}}'
        ].join('\n');
        document.head.appendChild(style);
    }

    function makeIconButton(icon, title, onClick) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'paper-icon-button-light chapterSkipBtn';
        btn.title = title;
        btn.disabled = true;
        btn.innerHTML = '<span class="material-icons ' + icon + '" aria-hidden="true"></span>';
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    function setupPlayer(player) {
        if (player.__chapterSkip) return;
        player.__chapterSkip = true;
        injectStyles();

        var state = { itemId: null, swiper: null, chapters: null, cardDismissed: false };

        var prevBtn = makeIconButton('skip_previous', 'Previous chapter', function () {
            if (state.chapters) goToChapter(player, state, state.chapters.prev, false);
        });
        var nextBtn = makeIconButton('skip_next', 'Next chapter', function () {
            if (state.chapters) goToChapter(player, state, state.chapters.next, true);
        });

        var card = document.createElement('div');
        card.className = 'chapterSkipCard hide';
        card.innerHTML = '<div class="chapterSkipText"><small>End of chapter</small><span class="chapterSkipName"></span></div>'
            + '<button type="button" class="chapterSkipGo">Next chapter &#8250;</button>'
            + '<button type="button" class="chapterSkipClose" title="Dismiss">&#215;</button>';
        // Clicks on the card shouldn't toggle the reader's toolbar.
        card.addEventListener('click', function (e) { e.stopPropagation(); });
        card.querySelector('.chapterSkipGo').addEventListener('click', function () {
            if (state.chapters) goToChapter(player, state, state.chapters.next, true);
        });
        card.querySelector('.chapterSkipClose').addEventListener('click', function () {
            state.cardDismissed = true;
            updateCard();
        });

        function placeButtons() {
            if (prevBtn.isConnected) return true;
            var rows = player.querySelectorAll('.bookOsd .bookOsdRow');
            var bottom = rows[rows.length - 1];
            if (!bottom || rows.length < 2) return false;
            // Put them right after the reader's own previous/next page buttons.
            var anchor = bottom.querySelectorAll('button')[1];
            if (anchor && anchor.nextSibling) {
                bottom.insertBefore(prevBtn, anchor.nextSibling);
                bottom.insertBefore(nextBtn, prevBtn.nextSibling);
            } else {
                bottom.appendChild(prevBtn);
                bottom.appendChild(nextBtn);
            }
            return true;
        }

        function updateCard() {
            var next = state.chapters && state.chapters.next;
            var show = !!(next && state.swiper && state.swiper.isEnd && !state.cardDismissed && !busy);
            if (next) card.querySelector('.chapterSkipName').textContent = next.Name;
            card.classList.toggle('hide', !show);
        }

        function onKeyDown(e) {
            if (!document.body.contains(player)) {
                document.removeEventListener('keydown', onKeyDown, true);
                return;
            }
            if (e.ctrlKey || e.altKey || e.metaKey || !state.chapters) return;
            var tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            var key = (e.key || '').toLowerCase();
            if (key === 'n' && !e.shiftKey) {
                goToChapter(player, state, state.chapters.next, true);
            } else if (key === 'p' && !e.shiftKey) {
                goToChapter(player, state, state.chapters.prev, false);
            } else if ((key === 'arrowright' || key === 'arrowleft') && state.swiper && state.swiper.isEnd && state.chapters.next) {
                // Swiper flips arrow keys in right-to-left mode.
                var rtl = !!state.swiper.rtlTranslate;
                var forwardKey = rtl ? 'arrowleft' : 'arrowright';
                if (key === forwardKey && !e.shiftKey && state.wasAtEnd) {
                    goToChapter(player, state, state.chapters.next, true);
                }
            }
        }
        document.addEventListener('keydown', onKeyDown, true);

        // Wait for the reader to finish loading the archive (Swiper exists by then).
        waitFor(function () {
            var container = player.querySelector('.slideshowSwiperContainer');
            return container && container.swiper;
        }, 120000, 200).then(function (swiper) {
            if (!swiper || !document.body.contains(player)) return;
            state.swiper = swiper;
            state.itemId = lastDownloadedItemId;
            if (!state.itemId) {
                console.warn(LOG, 'could not tell which book is open');
                return;
            }

            waitFor(placeButtons, 5000, 100);

            swiper.on('slideChange', function () {
                // Remember whether we were already on the last page *before* this change,
                // so the "one more arrow press" shortcut needs a deliberate extra press.
                state.wasAtEnd = false;
                state.cardDismissed = false;
                setTimeout(function () {
                    state.wasAtEnd = swiper.isEnd;
                    updateCard();
                }, 0);
            });
            state.wasAtEnd = swiper.isEnd;

            return getChapters(state.itemId).then(function (chapters) {
                state.chapters = chapters;
                prevBtn.disabled = !chapters.prev;
                nextBtn.disabled = !chapters.next;
                if (chapters.prev) prevBtn.title = 'Previous chapter: ' + chapters.prev.Name;
                if (chapters.next) nextBtn.title = 'Next chapter: ' + chapters.next.Name;
                player.appendChild(card);
                updateCard();
            });
        }).catch(function (e) {
            console.error(LOG, e);
        });
    }

    // ---------------------------------------------------------------------------
    // 5. Watch for the reader opening
    // ---------------------------------------------------------------------------
    function scan() {
        var player = document.getElementById('comicsPlayer');
        if (player) setupPlayer(player);
    }

    function start() {
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
        scan();
        console.log(LOG, 'loaded');
    }

    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
})();
