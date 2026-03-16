#!/usr/bin/env ruby
# frozen_string_literal: true
#
# add_frameworks.rb
#
# Patches the Xcode project after `react-native init` to:
#   1. Add HealthKit.framework   (heart rate + step count)
#   2. Add DeviceCheck.framework (App Attest / DCAppAttestService)
#   3. Add native Swift/ObjC source files to the compile phase
#   4. Set CODE_SIGN_ENTITLEMENTS for both Debug and Release configs
#
# Prerequisites: `gem install xcodeproj` (installed automatically with CocoaPods)
# Run from presence-test-app/:  ruby ios-patches/add_frameworks.rb

require 'xcodeproj'

APP_NAME        = 'PresenceTestApp'
PROJECT_PATH    = File.expand_path("ios/#{APP_NAME}.xcodeproj", __dir__ + '/..')
NATIVE_SRC_DIR  = File.expand_path('../../presence-mobile-native/ios/PresenceMobile', File.dirname(__FILE__))
ENTITLEMENTS    = "#{APP_NAME}/#{APP_NAME}.entitlements"

abort "❌  Project not found at #{PROJECT_PATH}\n    Run setup.sh first." unless File.exist?(PROJECT_PATH)

puts "→  Opening #{PROJECT_PATH}"
project = Xcodeproj::Project.open(PROJECT_PATH)

target = project.targets.find { |t| t.name == APP_NAME }
abort "❌  Target '#{APP_NAME}' not found in project." unless target

# ── 1. System frameworks ──────────────────────────────────────────────────────

FRAMEWORKS = %w[HealthKit.framework DeviceCheck.framework].freeze

FRAMEWORKS.each do |fw_name|
  already = target.frameworks_build_phase.files_references.any? { |r| r.path == fw_name }
  if already
    puts "   #{fw_name} already linked — skipped"
    next
  end

  ref = project.frameworks_group.new_reference(fw_name)
  ref.name                  = fw_name
  ref.source_tree           = 'SDKROOT'
  ref.last_known_file_type  = 'wrapper.framework'
  target.frameworks_build_phase.add_file_reference(ref)
  puts "✅  Linked #{fw_name}"
end

# ── 2. Native module source files ─────────────────────────────────────────────

abort "❌  Native source dir not found:\n    #{NATIVE_SRC_DIR}\n    Clone presence-mobile-native alongside this repo." \
  unless File.directory?(NATIVE_SRC_DIR)

app_group = project.main_group[APP_NAME]
abort "❌  Group '#{APP_NAME}' not found in project navigator." unless app_group

swift_and_objc = Dir.glob(File.join(NATIVE_SRC_DIR, '*.{swift,m}')).sort

swift_and_objc.each do |src_path|
  filename = File.basename(src_path)

  # Check already referenced
  if app_group.files.any? { |f| f.path == filename }
    puts "   #{filename} already in project — skipped"
    next
  end

  file_ref = app_group.new_reference(filename)
  file_ref.path = filename

  # Infer file type
  file_ref.last_known_file_type = filename.end_with?('.swift') ? 'sourcecode.swift' : 'sourcecode.c.objc'

  target.source_build_phase.add_file_reference(file_ref)
  puts "✅  Added #{filename} to compile sources"
end

# ── 3. Entitlements ───────────────────────────────────────────────────────────

target.build_configurations.each do |config|
  old = config.build_settings['CODE_SIGN_ENTITLEMENTS']
  if old && old == ENTITLEMENTS
    puts "   CODE_SIGN_ENTITLEMENTS already set for #{config.name} — skipped"
  else
    config.build_settings['CODE_SIGN_ENTITLEMENTS'] = ENTITLEMENTS
    puts "✅  CODE_SIGN_ENTITLEMENTS = #{ENTITLEMENTS}  (#{config.name})"
  end
end

# ── 4. Swift bridging — ensure SWIFT_OBJC_BRIDGING_HEADER is set ──────────────
#
# RN 0.74 projects use .mm AppDelegate by default (no bridging header needed).
# If your project uses a .swift AppDelegate you may need to add one.
# This is handled automatically by Xcode when you add the first Swift file.

# ── Save ─────────────────────────────────────────────────────────────────────

project.save
puts "\n✅  Xcode project patched successfully."
puts "    Open ios/#{APP_NAME}.xcworkspace (not .xcodeproj) in Xcode."
