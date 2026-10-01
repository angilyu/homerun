Pod::Spec.new do |s|
  s.name           = 'HomerunNative'
  s.version        = '0.0.0'
  s.summary        = 'The bridge between the iPhone app’s JavaScript and HomerunKit'
  s.license        = { :type => 'Proprietary' }
  s.author         = 'Homerun'
  s.homepage       = 'https://github.com/angilyu/homerun'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true
  s.source_files   = 'Bridge/**/*.swift'
  s.frameworks     = 'AuthenticationServices', 'UserNotifications', 'UIKit'
  s.dependency 'ExpoModulesCore'
  s.dependency 'HomerunKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
