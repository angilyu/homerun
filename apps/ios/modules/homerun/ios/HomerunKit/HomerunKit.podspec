Pod::Spec.new do |s|
  s.name           = 'HomerunKit'
  s.version        = '0.0.0'
  s.summary        = 'Homerun protocol code for the iPhone app and its Notification Service Extension'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'Homerun'
  s.homepage       = 'https://github.com/angilyu/homerun'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.source_files   = 'Sources/HomerunKit/**/*.swift'
  s.frameworks     = 'CryptoKit', 'Security', 'LocalAuthentication', 'DeviceCheck', 'UserNotifications'
  # The extension links this too: only extension-safe API.
  s.pod_target_xcconfig = { 'APPLICATION_EXTENSION_API_ONLY' => 'YES', 'DEFINES_MODULE' => 'YES' }
end
