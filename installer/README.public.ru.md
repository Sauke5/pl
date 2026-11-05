# PL: установка и подготовка исходников

Новая установка загружает только API, web и PostgreSQL. Модули устанавливаются из web PL по мере необходимости; их образы отсутствуют в core-архиве.

## Быстрый запуск

На Ubuntu или Debian:

```sh
curl -fsSL https://raw.githubusercontent.com/Sauke5/pl/main/installer/get-pl.sh | sudo sh
```

Bootstrap проверяет Ed25519-подпись каталога, размер и SHA256 пакета. Адрес HTTPS определяется автоматически. Для собственного домена можно заранее сохранить скрипт и передать его явно:

```sh
curl -fsSLo get-pl.sh https://raw.githubusercontent.com/Sauke5/pl/main/installer/get-pl.sh
sudo sh get-pl.sh --public-url https://pl.example.test
```

Первый запуск создаёт самоподписанный TLS-сертификат. Доверенный сертификат можно загрузить в настройках PL. При повторном запуске установщик сохраняет существующий сертификат.

Первоначальные данные входа — `admin` / `admin`. После входа смените пароль в интерфейсе. Повторный запуск сохраняет пароль и существующие данные.

Карточки, системы, внешние подключения, пользователи и Active Directory настраиваются в PL. Модули устанавливаются в каталоге; новые версии core проверяются и применяются в настройках. Для AD сохраняется проверка TLS и имени сервера. Приватный ключ шифрования credentials принадлежит установке и должен входить в её backup.

В «Настройки → Развёртывание» меняются адрес PL, интерфейс сервера, TLS-сертификат, разрешённые сети и порты источников и CA внешних HTTPS-интеграций. PL проверяет параметры перед применением и восстанавливает предыдущую конфигурацию при неудаче. Смена адреса установленного native-приложения выполняется вместе с его настройками и согласованным снимком данных.

## Сборка

Из корня репозитория с локальным Docker:

```sh
python3 installer/package.py context --output release/generated/pl-source.tar.gz
python3 installer/package.py build --source-archive release/generated/pl-source.tar.gz --version VERSION --output release/generated/pl-VERSION.tar.gz
```

По умолчанию `build` создаёт только core. Дополнительные исходники выбираются флагами `context --with-*`. Отдельный модуль собирается командой `module --module-id MODULE` из context с его исходниками; точные доступные имена и параметры показывает `python3 installer/package.py --help`.

```sh
python3 installer/package.py context --with-forms --output release/generated/pl-forms-source.tar.gz
python3 installer/package.py module --module-id forms --source-archive release/generated/pl-forms-source.tar.gz --version VERSION --output release/generated/pl-forms-VERSION.tar.gz
```

Артефакты immutable: существующий version/file не перезаписывается другой сборкой. Публичный каталог подписывается отдельным release key; приватный ключ не входит в исходники и образы. Смена PostgreSQL major и несовместимого протокола модулей требует отдельного перехода.

## Проверки и восстановление

```sh
python3 -m unittest discover -s installer/tests
```

На macOS для canonical-path тестов используйте `TMPDIR=/private/tmp`. Go integration tests требуют отдельную PostgreSQL; frontend и component tests запускаются из соответствующего приложения. Unit tests не подтверждают установку или пользовательский сценарий.

Web upgrade создаёт согласованный snapshot установки, включая данные локальных модулей. При неудаче требуется возвращать и данные, и образы. Отдельная [утилита maintenance](maintenance.ru.md) сохраняет прежний ограниченный контракт backup/restore core и отказывает при локальных модулях; она не заменяет snapshot web upgrade.

Обе standalone-админки, host-agent и Reports доступны как исходные компоненты; они не устанавливаются вместе с core автоматически. Их размещение и доступ задаются для конкретной установки. File Auditor требует отдельной Windows-приёмки службы и сканирования.

Перед публичным экспортом новые выбранные исходники должны быть добавлены в Git index: exporter использует тот же allowlist, что и source builder. `python3 installer/public-export.py` создаёт новый каталог `release/generated/public-pl` с manifest и не переносит историю Git. Отчёт аудита остаётся в `release/private` и не входит в публикуемые файлы.
