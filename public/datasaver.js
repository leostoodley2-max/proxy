// Data saver: what the service worker doesn't download at all (adverts,
// ad auctions, trackers), and the advert parts it removes from YouTube's
// answers so the ad videos are never fetched. Loaded by sw.js.
"use strict";

self.OrbitDataSaver = (() => {
  // Blocked with all their subdomains. Only advertising and tracking: no CDNs,
  // sign-in, anti-bot or game-save services.
  const domains = [
    // Google advertising and analytics
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
    "googletagmanager.com", "googletagservices.com", "adservice.google.com", "adtrafficquality.google",
    "2mdn.net", "imasdk.googleapis.com", "pagead2.googlesyndication.com",
    // Ad exchanges and header bidding
    "adnxs.com", "criteo.com", "criteo.net", "rubiconproject.com", "pubmatic.com", "openx.net", "openxcdn.net",
    "casalemedia.com", "indexww.com", "amazon-adsystem.com", "adsrvr.org", "smartadserver.com", "33across.com",
    "kargo.com", "media.net", "sharethrough.com", "triplelift.com", "3lift.com", "sonobi.com", "gumgum.com",
    "teads.tv", "yieldmo.com", "bidswitch.net", "adform.net", "smaato.net", "inmobi.com", "nexx360.io",
    "the-ozone-project.com", "creativecdn.com", "adsafeprotected.com", "moatads.com", "doubleverify.com",
    "outbrain.com", "taboola.com", "revcontent.com", "mgid.com", "adroll.com", "quantserve.com",
    "scorecardresearch.com", "adcolony.com", "applovin.com", "unityads.unity3d.com", "vungle.com",
    "a-mo.net", "springserve.com", "spotxchange.com", "lijit.com", "contextweb.com", "districtm.io",
    "e-planning.net", "improvedigital.com", "adkernel.com", "yahoo.net", "advertising.com",
    // Identity sync and trackers
    "id5-sync.com", "liadm.com", "crwdcntrl.net", "hadron.ad.gt", "privacymanager.io", "optable.co",
    "rapidedge.io", "rlcdn.com", "bluekai.com", "demdex.net", "krxd.net", "exelator.com", "agkn.com",
    "tapad.com", "hotjar.com", "clarity.ms", "mouseflow.com", "fullstory.com", "segment.io", "mixpanel.com",
    "amplitude.com", "connect.facebook.net", "ads-twitter.com", "analytics.tiktok.com", "ads.linkedin.com",
    "bat.bing.com", "adlightning.com",
  ];
  // Paths on otherwise-allowed hosts.
  const paths = [
    [/(^|\.)youtube\.com$/, /^\/(pagead\/|api\/stats\/ads|ptracking|get_midroll_|youtubei\/v1\/player\/ad_break)/],
    [/(^|\.)google\.com$/, /^\/(pagead\/|adsense\/|ads\/|afs\/)/],
  ];
  function blocked(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    const host = u.hostname.toLowerCase();
    if (domains.some((d) => host === d || host.endsWith("." + d))) return true;
    return paths.some(([h, p]) => h.test(host) && p.test(u.pathname));
  }

  // Empty but valid stand-ins, so pages carry on as if the ad just didn't fill.
  const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
  function emptyResponse(destination) {
    const type = { script: "text/javascript", style: "text/css", image: "image/gif", document: "text/html", iframe: "text/html" }[destination];
    if (!type) return new Response(null, { status: 204 });
    const body = destination === "image" ? GIF : "";
    return new Response(body, { status: 200, headers: { "Content-Type": type, "Cache-Control": "no-store" } });
  }

  // YouTube lists the adverts to play in its JSON answers; without these
  // keys the player never fetches the ad videos.
  const AD_KEYS = ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams", "adBreakParams"];
  const isYouTubeApi = (url) => /^https:\/\/(www\.|m\.)?youtube\.com\/youtubei\/v1\/(player|next|browse|search|reel\/)/.test(url);
  function stripAds(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6) return 0;
    let removed = 0;
    for (const key of AD_KEYS) if (key in value) { delete value[key]; removed++; }
    for (const key of ["playerResponse", "response"]) if (value[key]) removed += stripAds(value[key], depth + 1);
    if (Array.isArray(value)) for (const item of value) removed += stripAds(item, depth + 1);
    return removed;
  }
  async function cleanYouTube(response) {
    if (!/json/.test(response.headers.get("content-type") || "")) return response;
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { return new Response(text, response); }
    if (!stripAds(data)) return new Response(text, response);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
  }

  // YouTube plays muted previews on the home page, search results, feeds and
  // channels: several MB each, unasked. Video data is only let through for
  // pages where someone is actually watching.
  function youtubePreview(url, pageUrl) {
    let u, page;
    try { u = new URL(url); page = new URL(pageUrl); } catch (e) { return false; }
    if (!/(^|\.)googlevideo\.com$/.test(u.hostname) || u.pathname !== "/videoplayback") return false;
    if (!/^(www\.|m\.)?youtube\.com$/.test(page.hostname)) return false;
    return !/^\/(watch|shorts\/|live\/|embed\/|clip\/|v\/)/.test(page.pathname);
  }

  return { blocked, emptyResponse, isYouTubeApi, cleanYouTube, stripAds, youtubePreview };
})();
