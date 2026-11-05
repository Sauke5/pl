# Refresh explicitly approved public SSH host keys on every owned HTTP-source load.
require 'oxidized'
require 'oxidized/source/source'
require 'oxidized/source/http'
require 'json'
require 'net/http'
require 'fileutils'
module PlKnownHostsSource
  def load(*args)
    config = JSON.parse(File.read('/run/secrets/oxidized.json'))
    uri = URI('http://adapter:8092/internal/oxidized/trust')
    request = Net::HTTP::Get.new(uri)
    request.basic_auth('oxidized', config.fetch('source_password'))
    response = Net::HTTP.start(uri.host, uri.port, read_timeout: 5) { |http| http.request(request) }
    raise 'Owned SSH trust source unavailable' unless response.code == '200' && response.body.bytesize <= 262_144
    lines = JSON.parse(response.body).fetch('known_hosts')
    raise 'Invalid owned SSH trust payload' unless lines.is_a?(String) && lines.bytesize <= 262_144
    directory = File.join(ENV.fetch('HOME'), '.ssh')
    FileUtils.mkdir_p(directory, mode: 0700)
    temp = File.join(directory, 'known_hosts.new')
    File.write(temp, lines, mode: 'w', perm: 0600)
    File.rename(temp, File.join(directory, 'known_hosts'))
    super
  end
end
Oxidized::Source::HTTP.prepend(PlKnownHostsSource)
