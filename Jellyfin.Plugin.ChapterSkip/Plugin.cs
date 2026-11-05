using System;
using System.IO;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.ChapterSkip;

/// <summary>
/// Adds "previous / next chapter" controls to the web client's comic reader.
/// On server start it inlines a small script into jellyfin-web's index.html
/// (between marker comments, so it is replaced cleanly on update and removed on uninstall).
/// </summary>
public class Plugin : BasePlugin<BasePluginConfiguration>
{
    private const string StartMarker = "<!-- ChapterSkip:start -->";
    private const string EndMarker = "<!-- ChapterSkip:end -->";
    private const string ResourceName = "ChapterSkip.chapterskip.js";

    private readonly IApplicationPaths _paths;
    private readonly ILogger<Plugin> _logger;

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
        : base(applicationPaths, xmlSerializer)
    {
        _paths = applicationPaths;
        _logger = logger;
        UpdateIndexHtml(inject: true);
    }

    public override string Name => "Chapter Skip";

    public override Guid Id => Guid.Parse("5a54a0b5-3654-4a1b-81f4-2b3f0f81b262");

    public override string Description =>
        "Adds previous/next chapter buttons to the comic & manga reader, plus a 'Next chapter' prompt on the last page.";

    public override void OnUninstalling()
    {
        UpdateIndexHtml(inject: false);
        base.OnUninstalling();
    }

    private void UpdateIndexHtml(bool inject)
    {
        var indexPath = Path.Combine(_paths.WebPath, "index.html");
        try
        {
            if (!File.Exists(indexPath))
            {
                _logger.LogWarning("Chapter Skip: web client not found at {Path}; nothing to do.", indexPath);
                return;
            }

            var original = File.ReadAllText(indexPath);
            var html = RemoveBlock(original);

            if (inject)
            {
                var bodyEnd = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
                if (bodyEnd < 0)
                {
                    _logger.LogWarning("Chapter Skip: no </body> tag in {Path}; script not injected.", indexPath);
                    return;
                }

                var block = StartMarker + "<script>" + ReadScript() + "</script>" + EndMarker;
                html = html.Insert(bodyEnd, block);
            }

            if (!string.Equals(html, original, StringComparison.Ordinal))
            {
                File.WriteAllText(indexPath, html);
                _logger.LogInformation("Chapter Skip: {Action} {Path}", inject ? "injected script into" : "removed script from", indexPath);
            }
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogError(
                ex,
                "Chapter Skip: Jellyfin can't write to {Path}. Give the Jellyfin user write access to that file, "
                + "or paste chapterskip.js into the 'JavaScript Injector' plugin instead.",
                indexPath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Chapter Skip: failed to update {Path}", indexPath);
        }
    }

    private static string RemoveBlock(string html)
    {
        var start = html.IndexOf(StartMarker, StringComparison.Ordinal);
        if (start < 0)
        {
            return html;
        }

        var end = html.IndexOf(EndMarker, start, StringComparison.Ordinal);
        return end < 0 ? html : html.Remove(start, end + EndMarker.Length - start);
    }

    private static string ReadScript()
    {
        using var stream = typeof(Plugin).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("Embedded script missing: " + ResourceName);
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
