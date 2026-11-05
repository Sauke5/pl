# PL UI v1

Общий каркас и базовые визуальные примитивы для собственных интерфейсов PL. Пакет используется в сборках React и страницах без framework; самостоятельную авторизацию и предметные операции не реализует. Версия 1.0.2-pl.1 закрепляет размеры иконок навигации и footer, ширину каркаса в flex-контейнере и компоновку подписи sidebar. Runtime API остаётся v1.

`core.js` подключается как обычный browser script и публикует `window.PLUI` с `version: 1`. Для React доступен `@pl/ui/react`, стили — `@pl/ui/styles.css`. Тема использует существующий `window.PLTheme`: загрузить его catalog/runtime до создания shell и подключить `theme-menu.css`. При отсутствии контроллера приложение работает, кнопка выбора темы отключена.

```js
const shell = PLUI.createShell({
  context: 'Формы',
  user: { name: 'Иван', subtitle: 'Пользователь Платформы' },
  onLogout: () => logout(),
});
shell.slots.navigation.append(navigationElement);
shell.slots.main.append(contentElement);
document.body.append(shell.element);
// При размонтировании приложения:
// shell.destroy();
```

Параметры: `sidebar` (по умолчанию true), `wide` (полноширинный main), `platformHref`, `context`, `user`, `navigationId`, `mainId`, `onPlatformNavigate(event)`, `onLogout(event)` и `onCollapsedChange(boolean)`. Ссылка и кнопка выхода передают управление приложению; каркас сам не выполняет auth-запросы. Пока асинхронный logout выполняется, повторное нажатие отключено. Без callback logout скрыт.

Контроллер возвращает `element`, слоты `navigation`, `sidebarFooter`, `breadcrumb`, `actions`, `main`, `banner`, `footer`, `overlays`, методы `setUser({name, subtitle})`, `setContext(text)`, `setLogoutDisabled(boolean)` и `destroy()`. В breadcrumb уже присутствует ссылка на Платформу. Данные пользователя и текущего раздела устанавливаются как текст. `destroy` удаляет обработчики общего меню и подписку sidebar.

`PLUI.sidebar.get()`, `set(boolean)`, `subscribe(fn)` управляют состоянием сворачивания; подписка возвращает функцию отписки. Ключ `pl-ui-sidebar-collapsed` хранится в localStorage и синхронизируется между вкладками того же origin. При недоступном storage выбор работает в пределах текущей страницы. Для внешних обновлений внутри одной вкладки используйте `set`, не прямую запись в storage.

`PLUI.createBrand({platformHref, onPlatformNavigate})` создаёт общий знак. `PLUI.buttonClasses({variant, size, className})` возвращает классы: варианты `default`, `secondary`, `ghost`, `destructive`; размеры `default`, `sm`, `icon`. CSS-классы `.pl-ui-panel`, `.pl-ui-input`, `.pl-ui-select`, `.pl-ui-textarea`, `.pl-ui-sidebar-caption`, `.pl-ui-nav-item` применяются по выбору. В ссылках меню `.nav-label` скрывается при сворачивании; текст должен оставаться доступным через `title`/`aria-label`.

При доставке отдельно собираемых приложений использовать зафиксированный пакет и lockfile или pinned vendored tarball; не рассчитывать на одинаковый сборочный context. При обновлении общей версии проверять consumers и совместимость `/ecosystem/` assets. Обычный npm pack включает только исходные `core.js`, `react.tsx`, `styles.css` и package metadata.

Проверка из каталога frontend: `PL_TEST_BROWSER_CHANNEL=chrome node --test packages/pl-ui/core.test.cjs`.

React: `PlatformShell` принимает `navigation`, `sidebarFooter`, `actions`, `breadcrumbExtra`, `banner`, `footer`, `overlays`, `children`, `context`, `user`, `onLogout`, `logoutDisabled`, `initialCollapsed`, `onCollapsedChange`, `platformHref`, `onPlatformNavigate`, `sidebar`, `wide`, `mainClassName`, `shellClassName`. Callback выхода возвращает Promise выполняющегося запроса. Если навигационный guard отложил действие, приложение передаёт `logoutDisabled` во время фактического запроса. Переходы с Ctrl/⌘/Shift сохраняют стандартное поведение браузера.

`@pl/ui/primitives` экспортирует `Field`, `Panel`, `Badge`, `Empty`, `Alert`; `Button` импортируется из `@pl/ui/react`. Предметные статусы, форматирование ошибок и данные передаются приложением. Для native HTML те же роли доступны через CSS-классы и `buttonClasses`. Общий `@pl/ui/dialog` использует уже имеющиеся Radix Dialog и Motion как optional peers; они нужны только потребителю этого entry point. Приложение может передать действия заголовка и footer, а также `blockClose` для вложенной помощи. Страница с native `<dialog>` использует `.pl-ui-native-dialog` и стандартные `showModal()/close()`.

Branding: `branding: {name, subtitle, label}` доступен в `PLUI.createShell`, `PLUI.createBrand`, React `PlatformShell` и `Brand`. По умолчанию — `PL`, `PLATFORM`, `Platform`. Значения вставляются как текст.

`npm run ui:build` обновляет только локальные public assets. Явный `--standalone` дополнительно синхронизирует standalone admin copies; для portable core он не нужен.
