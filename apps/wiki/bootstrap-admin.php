<?php
/** Initialize only the upstream default administrator, with no secret in argv/output. */
declare(strict_types=1);

chdir('/app/www');
require '/app/www/vendor/autoload.php';
$app = require '/app/www/bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();
$password = file_get_contents('/run/secrets/admin_password');
if (!is_string($password) || !preg_match('/^(?:[A-Za-z0-9]{8}|[0-9a-f]{64})$/D', $password)) {
    fwrite(STDERR, "Invalid BookStack bootstrap credential\n");
    exit(1);
}
// --initial updates admin@admin.com, or returns 2 once a non-default admin exists.
// It never rotates an administrator password on enable or container recreation.
$result = Illuminate\Support\Facades\Artisan::call('bookstack:create-admin', [
    '--initial' => true,
    '--email' => 'admin@pl.invalid',
    '--name' => 'Administrator',
    '--password' => $password,
]);
if (!in_array($result, [0, 2], true)) {
    fwrite(STDERR, "BookStack administrator initialization failed\n");
    exit(1);
}
