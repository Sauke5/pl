require 'json'
require 'fileutils'
require 'yaml'
require 'net/http'
require 'uri'
require 'securerandom'
config = JSON.parse(File.read('/run/secrets/oxidized.json'))
home = '/home/oxidized/.config/oxidized'
FileUtils.mkdir_p(home)
# Adapter creates the private Gitea repo and scoped push token before publishing readiness.
loop do
  begin
    uri = URI('http://adapter:8092/internal/bootstrap')
    req = Net::HTTP::Get.new(uri)
    req.basic_auth('oxidized', config.fetch('source_password'))
    response = Net::HTTP.start(uri.host, uri.port, read_timeout: 5) { |http| http.request(req) }
    if response.code == '200'
      remote = JSON.parse(response.body)
      config['push_token'] = remote.fetch('push_token')
      break
    end
  rescue StandardError
    # No upstream response body or secrets in logs.
  end
  sleep 2
end
value = {
  'interval' => 3600, 'threads' => 4, 'timeout' => 20, 'retries' => 1,
  'resolve_dns' => false, 'use_syslog' => false,
  'input' => {'default' => 'ssh', 'ssh' => {'secure' => true}},
  'source' => {'default' => 'http', 'http' => {'url' => 'http://adapter:8092/internal/oxidized/nodes',
    'user' => 'oxidized', 'pass' => config.fetch('source_password'),
    'map' => {'name' => 'name', 'ip' => 'ip', 'model' => 'model', 'username' => 'username', 'password' => 'password'}}},
  'output' => {'default' => 'git', 'clean_obsolete_nodes' => false,
    'git' => {'user' => 'Pl Oxidized', 'email' => 'oxidized@localhost', 'single_repo' => true, 'repo' => "#{home}/devices.git"}},
  'hooks' => {'gitea' => {'type' => 'githubrepo', 'events' => ['post_store'],
    'remote_repo' => 'http://gitea:3000/pl-collector/device-configs.git',
    'username' => 'pl-collector', 'password' => config.fetch('push_token')}},
  'extensions' => {'oxidized-web' => {'load' => true, 'listen' => '0.0.0.0', 'port' => 8888, 'url_prefix' => 'netmap/oxidized', 'hide_node_vars' => ['password', 'enable']}}
}
File.write("#{home}/config", YAML.dump(value), mode: 'w', perm: 0600)
ENV['OXIDIZED_HOME'] = home
ENV['HOME'] = home
ENV['RUBYOPT'] = '-r/opt/pl/known-hosts-source.rb'
# Native Oxidized refuses to start with an empty source before its web API is
# created. Keep the owned wrapper alive until explicitly enrolled targets exist;
# this reads inventory only and never starts a discovery scan or dummy device.
loop do
  begin
    uri = URI('http://adapter:8092/internal/oxidized/nodes')
    req = Net::HTTP::Get.new(uri)
    req.basic_auth('oxidized', config.fetch('source_password'))
    response = Net::HTTP.start(uri.host, uri.port, open_timeout: 5, read_timeout: 5) { |http| http.request(req) }
    if response.code == '200' && response.body.bytesize <= 32 * 1024 * 1024
      nodes = JSON.parse(response.body)
      break if nodes.is_a?(Array) && !nodes.empty?
    end
  rescue StandardError
    # A failed source read is never interpreted as an empty successful inventory.
  end
  sleep 2
end
exec('oxidized')
