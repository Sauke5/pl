# Файловый аудитор: frontend

React-интерфейс для экземпляра Auditor. Параметр `AUDITOR_APP_BASE` задаёт базовый URL при сборке: `/audit/` или `/audit-arch/` в соответствии с выбранным gateway. Сборка попадает в `src/Auditor.Api/wwwroot` перед `dotnet publish`.

```sh
npm ci
npm run lint
AUDITOR_APP_BASE=/audit/ npm run build
```

Страницы и стили находятся в `src/workspace/`. API-запросы используют тот же префикс, что и frontend. Параметры запуска скана выбираются из списка корней, который возвращает сервер. Описание backend, контракта gateway и выпуска: [README проекта](../../README.md).
