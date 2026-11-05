import assert from "node:assert/strict";
import test from "node:test";
import {
  establishedTCP,
  formatBytes,
  trafficRoutes,
} from "../../src/proxyTelemetry.ts";

test("maps only confirmed outbound tags and keeps zero distinct from missing", () => {
  const routes = trafficRoutes({
    "outbound>>>office-ai-http-relay>>>traffic>>>downlink": 433742499,
    "outbound>>>office-ai-http-relay>>>traffic>>>uplink": 145771595,
    "outbound>>>final185>>>traffic>>>downlink": 1593860,
    "outbound>>>final2>>>traffic>>>uplink": 0,
    "outbound>>>direct>>>traffic>>>downlink": 791716,
    "outbound>>>proxy>>>traffic>>>downlink": 0,
    "outbound>>>future-route>>>traffic>>>downlink": 999999,
    "outbound>>>final185>>>traffic>>>other": 123,
  });

  assert.deepEqual(routes, [
    {
      tag: "office-ai-http-relay",
      label: "Edge · TCP",
      received: 433742499,
      sent: 145771595,
    },
    { tag: "proxy", label: "Edge · UDP", received: 0, sent: null },
    { tag: "final185", label: "185", received: 1593860, sent: null },
    { tag: "final2", label: "2.26", received: null, sent: 0 },
    {
      tag: "direct",
      label: "Прямой выход 4.14",
      received: 791716,
      sent: null,
    },
  ]);
});

test("formats IEC byte units without turning missing values into zero", () => {
  assert.equal(formatBytes(null), "Нет данных");
  assert.equal(formatBytes(0), "0 Б");
  assert.equal(formatBytes(1024), "1 КиБ");
  assert.equal(formatBytes(1048576), "1 МиБ");
  assert.equal(formatBytes(433742499), "414 МиБ");
  assert.equal(formatBytes(1536), "1,5 КиБ");
});

test("reads estab only from the anchored TCP summary", () => {
  assert.equal(
    establishedTCP(
      "Total: 2005\nTCP:   2460 (estab 1867, closed 573, orphaned 9)\nUDP: 2",
    ),
    1867,
  );
  assert.equal(establishedTCP("TCP: 17 (estab 0)"), 0);
  assert.equal(establishedTCP("estab 42\nTCP sockets: 99"), null);
  assert.equal(establishedTCP(""), null);
});
