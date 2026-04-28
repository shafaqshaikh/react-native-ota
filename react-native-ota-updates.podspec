require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = "react-native-ota-updates"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/your-org/react-native-ota-updates"
  s.license      = package["license"]
  s.author       = "Your Name"
  s.platform     = :ios, "13.4"
  s.source       = { :git => "https://github.com/your-org/react-native-ota-updates.git", :tag => s.version }
  s.source_files = "ios/**/*.{h,m,mm,c}"
  s.libraries    = "bz2"
  s.frameworks   = "Security"

  install_modules_dependencies(s)
end
