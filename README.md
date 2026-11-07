# PL

PL объединяет каталог ресурсов, диагностику, события и подключаемые модули. Core включает API, веб-интерфейс и PostgreSQL. Образы каждого модуля Платформа загружает при его установке.

## Установка

На сервере Ubuntu или Debian выполните:

```sh
curl -fsSL https://raw.githubusercontent.com/Sauke5/pl/main/installer/get-pl.sh | sudo sh -s -- --production
```

Установщик проверит подписанный каталог и пакет, запустит PL и выведет адрес для входа. Войдите как `admin`. Файл с начальным паролем указан в выводе установщика.

[Установка с HTTPS и прокси](installer/README.public.ru.md) · [Первые шаги в PL](installer/platform-guide.ru.md)

## Модули

В разделе **Модули** установите нужный сервис или подключите существующий, если такой режим есть в его карточке. Подписанный каталог определяет, какие сборки доступны для архитектуры сервера.

[Гид по модулям](installer/core-modules.ru.md) · [Лицензии компонентов](installer/LICENSES.txt)

## Обновления

Откройте **Настройки → Обновления**, проверьте наличие новой версии и прочитайте её описание. Кнопка **Обновить всё** запускает доступные совместимые обновления по очереди. При обновлении core Платформа показывает экран ожидания, затем возвращает пользователя в интерфейс.

Если GitHub доступен через прокси, выберите и проверьте его в разделе **Прокси для загрузок**.

[Обновления и прокси](installer/delivery.ru.md) · [Текущий стабильный выпуск](https://github.com/Sauke5/pl/releases/latest)

## Исходники и проверки

```sh
python3 -m unittest discover -s installer/tests
go -C monitoring/source/it-portal test ./...
npm --prefix monitoring/source/it-portal/frontend ci
npm --prefix monitoring/source/it-portal/frontend run build
```

PostgreSQL integration tests используют отдельную тестовую базу, заданную через `PORTAL_TEST_DATABASE_URL`. Сборка контейнеров выполняется локальным Docker через `installer/package.py`; сначала создайте allowlisted source context. Source tests, сборка образов, опубликованный релиз и runtime-приёмка — разные этапы.

`PUBLIC-SOURCE-MANIFEST.json` содержит hashes всех выбранных файлов. Этот репозиторий создан из проверенного экспорта; конфигурации установок, credentials, runtime-данные и прежняя история разработки не входят в него.

## Лицензия

Собственный код PL распространяется по [MIT](LICENSE). Зависимости и отдельные приложения сохраняют свои лицензии и авторство; подробности — в [NOTICE](NOTICE), исходниках компонентов и `deploy/images/*.sources.json`. MIT для PL не изменяет условий Grafana, HeyForm, SFTPGo, NetBox, BookStack и других сторонних компонентов.
