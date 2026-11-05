# PL File Auditor

Исходники отдельной Windows-службы FileStructureAuditor и её web-интерфейса. Core PL не устанавливает Windows-службу автоматически. Сканер использует Windows API: компиляция и тесты в Linux SDK не подтверждают работу службы или сканирование Windows-файловой системы.

Для своей установки задайте SQLite storage, доступные корни сканирования, параметры Windows Service, журналирования и TLS. Gateway требует `Gateway:Enabled`, `Gateway:PathBase` и `Gateway:KeyFile`; файл должен содержать индивидуальный ключ из 32 raw bytes и читаться только нужным процессом. В Production отключить проверку gateway нельзя. Данные, customer paths и ключи не входят в исходники.

[Контракт gateway v2](docs/gateway-v2-contract.md) · [Удаление собственной установки](docs/uninstall.md)

Проверка исходников:

```sh
dotnet test --project tests/Auditor.Tests/Auditor.Tests.csproj
cd src/Auditor.Web
npm ci
npm run lint
AUDITOR_APP_BASE=/audit/ npm run build
npm run test:browser
```

Browser tests запускают локальный fixture API и требуют Chromium/WebKit отдельно. Общий `@pl/ui` включён как локальный versioned archive в `src/Auditor.Web/vendor/`. Зависимости сохраняют свои лицензии; собственный код PL лицензирован по корневому MIT.
