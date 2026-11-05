import { ErrorDisplay } from "./error-display";

export function ErrorTest() {
  const testError = new Error(
    "Не удалось подключиться к API текущей установки. Проверьте настройки подключения и состояние сервиса.",
  );

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-4">Проверка обработки ошибок</h2>
      <ErrorDisplay
        error={testError}
        title="Пример ошибки"
        className="min-h-[300px]"
      />
    </div>
  );
}
