type ProxyPath = "relay" | "final185" | "final2";

const activeDescriptions: Record<ProxyPath, string> = {
  relay: "4.14 → Edge → выходы",
  final185: "4.14 → 185 → Интернет",
  final2: "4.14 → 2.26 → Интернет",
};

export function ProxyRouteDiagram({
  activePath,
  current,
}: {
  activePath: ProxyPath | null;
  current: boolean;
}) {
  const state = !activePath
    ? "Активный путь не определён"
    : current
      ? `Активно: ${activeDescriptions[activePath]}`
      : `Последнее наблюдение: ${activeDescriptions[activePath]}`;
  const active = current ? activePath : null;

  return (
    <div className={`proxy-route-map ${current ? "" : "is-observation"}`}>
      <svg
        viewBox="200 0 600 440"
        role="img"
        aria-label={`Маршрут новых интернет-соединений. ${state}`}
      >
        <g className="proxy-route-lines">
          <path
            data-route="office-relay"
            className={active === "relay" ? "is-active" : ""}
            d="M500 60 V90"
          />
          <path
            data-route="relay-direct"
            className={active === "relay" ? "is-active-success" : ""}
            d="M430 115 H340 V175"
          />
          <path
            data-route="relay-final185"
            className={active === "relay" ? "is-active" : ""}
            d="M500 140 V245 H660 V270"
          />
          <path
            data-route="relay-final2"
            className={active === "relay" ? "is-active" : ""}
            d="M500 140 V245 H340 V270"
          />
          <path
            data-route="relay-block"
            className={active === "relay" ? "is-active-danger" : ""}
            d="M570 115 H660 V175"
          />
          <path
            data-route="office-final185"
            className={active === "final185" ? "is-active" : ""}
            d="M530 60 V75 H762 V295 H750"
          />
          <path
            data-route="office-final2"
            className={active === "final2" ? "is-active" : ""}
            d="M470 60 V75 H238 V295 H250"
          />
          <path
            data-route="final185-internet"
            className={
              active === "final185" || active === "relay" ? "is-active" : ""
            }
            d="M660 320 V345 H520 V370"
          />
          <path
            data-route="final2-internet"
            className={
              active === "final2" || active === "relay" ? "is-active" : ""
            }
            d="M340 320 V345 H480 V370"
          />
        </g>
        <g className="proxy-route-nodes">
          <g transform="translate(430 10)">
            <rect width="140" height="50" rx="12" />
            <text x="70" y="21">
              Офис
            </text>
            <text className="node-note" x="70" y="38">
              4.14
            </text>
          </g>
          <g
            className={active === "relay" ? "is-active" : ""}
            transform="translate(430 90)"
          >
            <rect width="140" height="50" rx="12" />
            <text x="70" y="31">
              Edge
            </text>
          </g>
          <g
            className={active === "relay" ? "is-active-success" : ""}
            transform="translate(250 175)"
          >
            <rect width="180" height="50" rx="10" />
            <text x="90" y="31">
              Direct
            </text>
          </g>
          <g
            className={
              active === "relay" || active === "final185" ? "is-active" : ""
            }
            transform="translate(570 270)"
          >
            <rect width="180" height="50" rx="10" />
            <text x="90" y="31">
              Final-185
            </text>
          </g>
          <g
            className={
              active === "relay" || active === "final2" ? "is-active" : ""
            }
            transform="translate(250 270)"
          >
            <rect width="180" height="50" rx="10" />
            <text x="90" y="31">
              Final-2.26
            </text>
          </g>
          <g
            className={active === "relay" ? "is-active-danger" : ""}
            transform="translate(570 175)"
          >
            <rect width="180" height="50" rx="10" />
            <text x="90" y="31">
              Block
            </text>
          </g>
          <g transform="translate(430 370)">
            <rect width="140" height="50" rx="12" />
            <text x="70" y="31">
              Интернет
            </text>
          </g>
        </g>
      </svg>
      {(!current || !activePath) && (
        <div className="proxy-route-caption">
          <strong>{state}</strong>
        </div>
      )}
    </div>
  );
}
