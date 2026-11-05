import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveResourceIcon,
  systemIconRules,
  resourceIconChoices,
} from "../../src/resourceIcons.ts";
import { systemIconExamples } from "../fixtures/systemIcons.ts";

test("all current applications resolve to a semantic SVG family", () => {
  for (const [name, key] of systemIconExamples) {
    assert.equal(
      resolveResourceIcon({ name, type: "Web-сервис" }).key,
      key,
      name,
    );
  }
  assert.equal(
    new Set(systemIconExamples.map(([, key]) => key)).size,
    systemIconRules.length,
  );
});
test("renamed applications retain identity from their allowed URL", () => {
  assert.equal(
    resolveResourceIcon({
      name: "Панели",
      url: "https://grafana.example.test/",
    }).key,
    "grafana",
  );
  assert.equal(
    resolveResourceIcon({ name: "Документы", url: "/wiki/" }).key,
    "wiki",
  );
  assert.equal(
    resolveResourceIcon({ name: "GRAFANA · панели", url: "/wiki/" }).key,
    "grafana",
  );
});
test("URL query, fragment, malformed URLs and credentials never supply identity", () => {
  for (const url of [
    "https://example.test/?app=grafana",
    "https://example.test/#grafana",
    "https://grafana:password@example.test/",
    "https://grafana.example.test/%zz",
    "javascript:grafana",
  ]) {
    assert.equal(
      resolveResourceIcon({ name: "Неизвестный сервис", url }).key,
      "web",
      url,
    );
  }
});
test("explicit employee icons override inferred product identity", () => {
  for (const [icon, key] of [
    ["book", "wiki"],
    ["folder", "folder"],
    ["support", "support"],
  ]) {
    assert.equal(
      resolveResourceIcon({ icon, name: "Grafana", url: "/prometheus/" }).key,
      key,
    );
  }
  assert.equal(
    resolveResourceIcon({ icon: "app", name: "1Ф · Vega" }).key,
    "vega",
  );
  assert.equal(
    resolveResourceIcon({ icon: "app", name: "Новая система" }).key,
    "app",
  );
});
test("unknown systems and infrastructure keep useful type fallbacks", () => {
  for (const [type, key] of [
    ["Сервер", "server"],
    ["Management", "bmc"],
    ["Виртуальная машина", "rds"],
    ["virtual machine", "rds"],
    ["vm", "rds"],
    ["Устройство", "server"],
    ["device", "server"],
    ["Сетевое оборудование", "network"],
    ["База данных", "database"],
    ["Хранилище", "folder"],
    ["Контейнер", "docker"],
    ["Безопасность", "security"],
    ["Мониторинг", "monitoring"],
    ["Web-сервис", "web"],
  ]) {
    assert.equal(
      resolveResourceIcon({ type, name: "Новый ресурс" }).key,
      key,
      type,
    );
  }
});

test("a physical host name does not imply its management interface", () => {
  assert.equal(
    resolveResourceIcon({ name: "Capella", type: "Сервер" }).key,
    "server",
  );
  assert.equal(
    resolveResourceIcon({ name: "BMC · Capella", type: "Management" }).key,
    "bmc",
  );
});

test("Doska and Forms use product names and safe URL identities", () => {
  for (const [name, key] of [
    ["Доска", "doska"],
    ["ДОСКА · задачи", "doska"],
    ["Doska", "doska"],
    ["Опросы", "forms"],
    ["Forms", "forms"],
    ["HeyForm", "forms"],
  ]) {
    assert.equal(resolveResourceIcon({ name }).key, key, name);
  }
  for (const [url, key] of [
    ["/doska/", "doska"],
    ["/forms/", "forms"],
    ["https://heyform.example.test/", "forms"],
  ]) {
    assert.equal(resolveResourceIcon({ name: "Сервис", url }).key, key, url);
  }
  assert.equal(
    resolveResourceIcon({ name: "Доска", url: "/forms/" }).key,
    "doska",
  );
  assert.equal(
    resolveResourceIcon({ name: "Опросы", url: "/doska/" }).key,
    "forms",
  );
  for (const name of ["Поддоска", "Опросывание", "Platforms"]) {
    assert.equal(resolveResourceIcon({ name }).key, "web", name);
  }
  for (const url of [
    "/?app=doska",
    "/#forms",
    "https://heyform:secret@example.test/",
  ]) {
    assert.equal(resolveResourceIcon({ name: "Сервис", url }).key, "web", url);
  }
  for (const [icon, key] of [
    ["book", "wiki"],
    ["folder", "folder"],
    ["support", "support"],
  ]) {
    assert.equal(resolveResourceIcon({ name: "Доска", icon }).key, key);
    assert.equal(resolveResourceIcon({ name: "Опросы", icon }).key, key);
  }
});
test("Doska and Forms infrastructure names retain type fallbacks", () => {
  for (const name of ["Doska", "Доска", "Forms", "Опросы"]) {
    assert.equal(
      resolveResourceIcon({ name, type: "Виртуальная машина", url: "/doska/" })
        .key,
      "rds",
    );
    assert.equal(resolveResourceIcon({ name, type: "Сервер" }).key, "server");
    assert.equal(
      resolveResourceIcon({ name, type: "Устройство" }).key,
      "server",
    );
  }
});

test("shared picker keys cover every shipped icon and manual selection wins inference", () => {
  const expected = [
    ...systemIconRules.map((rule) => rule.key),
    "server",
    "network",
    "database",
    "folder",
    "security",
    "monitoring",
    "app",
    "web",
  ].sort();
  assert.deepEqual(
    resourceIconChoices.map((choice) => choice.key).sort(),
    expected,
  );
  for (const { key } of resourceIconChoices) {
    assert.equal(
      resolveResourceIcon({ name: "Grafana", url: "/doska/", manualIcon: key })
        .key,
      key,
    );
  }
  assert.equal(
    resolveResourceIcon({ name: "Доска", manualIcon: "auto" }).key,
    "doska",
  );
  assert.equal(
    resolveResourceIcon({ name: "Доска", manualIcon: "unknown" }).key,
    "doska",
  );
  for (const [icon, key] of [
    ["book", "wiki"],
    ["folder", "folder"],
    ["support", "support"],
  ]) {
    assert.equal(
      resolveResourceIcon({ name: "Доска", manualIcon: "forms", icon }).key,
      "forms",
    );
    assert.equal(
      resolveResourceIcon({ name: "Доска", manualIcon: "auto", icon }).key,
      key,
    );
  }
});
