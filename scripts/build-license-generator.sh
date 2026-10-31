#!/usr/bin/env bash
# Builds the License Generator.
#  - Core library + tests run on any OS with the .NET 8 SDK:      dotnet test apps/license-generator/tests/SmartManager.Licensing.Tests
#  - The WPF app needs the Windows Desktop SDK (Microsoft's installer, on Windows):
#       dotnet publish apps/license-generator/src/SmartManager.LicenseGenerator -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
#    Output: apps/license-generator/src/SmartManager.LicenseGenerator/bin/Release/net8.0-windows/win-x64/publish/SmartManagerLicenseGenerator.exe
set -euo pipefail
cd "$(dirname "$0")/.."
export DOTNET_CLI_TELEMETRY_OPTOUT=1
dotnet test apps/license-generator/tests/SmartManager.Licensing.Tests
if [[ "${OS:-}" == "Windows_NT" || "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
  dotnet publish apps/license-generator/src/SmartManager.LicenseGenerator -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
else
  echo "Not on Windows: skipped the WPF publish step (needs the Windows Desktop SDK)."
fi
