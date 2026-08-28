using Workerd = import "/workerd/workerd.capnp";

# Optional local runtime smoke test. No sockets, external services or real secrets.
const config :Workerd.Config = (
  services = [
    (name = "adapters", worker = (
      compatibilityDate = "2024-01-01",
      modules = [
        (name = "test/workerd/redirect.mjs", esModule = embed "redirect.mjs"),
        (name = "functions/api/qweather.js", esModule = embed "../../functions/api/qweather.js"),
        (name = "functions/api/proxy.js", esModule = embed "../../functions/api/proxy.js"),
        (name = "functions/api/geocoding.js", esModule = embed "../../functions/api/geocoding.js"),
        (name = "server/qweather-geo.js", esModule = embed "../../server/qweather-geo.js"),
        (name = "server/geo-coordinates.js", esModule = embed "../../server/geo-coordinates.js"),
        (name = "server/edge-log.js", esModule = embed "../../server/edge-log.js")
      ],
      globalOutbound = "upstream"
    )),
    (name = "upstream", worker = (
      compatibilityDate = "2024-01-01",
      modules = [(name = "upstream.mjs", esModule = embed "upstream.mjs")]
    )),
    (name = "internet", network = (allow = []))
  ]
);
