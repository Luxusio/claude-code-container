$Root = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $Root 'Ccc.HyperV.Core.psm1') -Force
Import-Module (Join-Path $Root 'Ccc.HyperV.Linux.psm1') -Force
Import-Module (Join-Path $Root 'Ccc.HyperV.Diagnostics.psm1') -Force

Describe 'CCC Hyper-V JSON contracts' {
    It 'accepts the exact owned VM contract' {
        $Contract = [pscustomobject]@{
            schemaVersion = 1
            vmId = '12345678-1234-1234-1234-123456789abc'
            vmName = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
            ownershipMarker = 'ccc-device-lab:0123456789abcdef:linux-ci-01:11111111111111111111111111111111'
        }
        { Assert-CccOwnedVmContract $Contract } | Should -Not -Throw
    }

    It 'rejects missing and additional fields' {
        $Missing = [pscustomobject]@{ schemaVersion = 1; vmId = '12345678-1234-1234-1234-123456789abc' }
        $Additional = [pscustomobject]@{
            schemaVersion = 1
            vmId = '12345678-1234-1234-1234-123456789abc'
            vmName = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
            ownershipMarker = 'ccc-device-lab:0123456789abcdef:linux-ci-01:11111111111111111111111111111111'
            command = 'Get-Process'
        }
        { Assert-CccOwnedVmContract $Missing } | Should -Throw
        { Assert-CccOwnedVmContract $Additional } | Should -Throw
    }
}

Describe 'CCC Hyper-V VM ownership fencing' {
    InModuleScope Ccc.HyperV.Core {
        BeforeEach {
            $Contract = [pscustomobject]@{
                schemaVersion = 1
                vmId = '12345678-1234-1234-1234-123456789abc'
                vmName = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
                ownershipMarker = 'ccc-device-lab:0123456789abcdef:linux-ci-01:11111111111111111111111111111111'
            }
        }

        It 'rejects a missing VM' {
            Mock Get-CccVmById { @() }
            { Get-CccOwnedVm $Contract } | Should -Throw 'hyper-v-vm-not-found'
        }

        It 'rejects ambiguous VM identity' {
            Mock Get-CccVmById { @([pscustomobject]@{}, [pscustomobject]@{}) }
            { Get-CccOwnedVm $Contract } | Should -Throw 'hyper-v-vm-identity-ambiguous'
        }

        It 'rejects a name or marker mismatch' {
            Mock Get-CccVmById {
                @([pscustomobject]@{
                    Id = [Guid]$Contract.vmId
                    Name = $Contract.vmName
                    Notes = 'foreign-owner'
                })
            }
            { Get-CccOwnedVm $Contract } | Should -Throw 'hyper-v-vm-ownership-mismatch'
        }

        It 'returns the exact owned VM' {
            Mock Get-CccVmById {
                @([pscustomobject]@{
                    Id = [Guid]$Contract.vmId
                    Name = $Contract.vmName
                    Notes = $Contract.ownershipMarker
                })
            }
            (Get-CccOwnedVm $Contract).Name | Should -Be $Contract.vmName
        }
    }
}

Describe 'CCC Hyper-V Linux bootstrap address selection' {
    It 'keeps only same-prefix routable addresses' {
        $Prefixes = @([pscustomobject]@{ IPAddress = '172.20.0.1'; PrefixLength = 20 })
        $Selected = @(Select-CccBootstrapIpv4Address @('169.254.1.2', '172.20.1.8', '10.0.0.2') $Prefixes)
        $Selected.Count | Should -Be 1
        $Selected[0] | Should -Be '172.20.1.8'
    }

    It 'bounds the result to eight unique addresses' {
        $Prefixes = @([pscustomobject]@{ IPAddress = '172.20.0.1'; PrefixLength = 16 })
        $Candidates = 2..12 | ForEach-Object { '172.20.0.' + $_ }
        $Selected = @(Select-CccBootstrapIpv4Address $Candidates $Prefixes)
        $Selected.Count | Should -Be 8
    }
}

Describe 'CCC Hyper-V Linux bootstrap operation' {
    It 'reads the default switch and returns a bounded result contract' {
        $Vm = [pscustomobject]@{ Id = [Guid]'12345678-1234-1234-1234-123456789abc' }
        $Result = Get-CccLinuxBootstrapNetworkResult -Vm $Vm `
            -VmAdapterReader { param($TargetVm) @([pscustomobject]@{ Name = 'CCC Bootstrap DHCP'; SwitchName = 'Default Switch'; IPAddresses = @('172.20.1.8', '169.254.1.2') }) } `
            -ManagementAdapterReader { @([pscustomobject]@{ IPAddresses = @('172.20.0.1') }) } `
            -HostPrefixReader { @([pscustomobject]@{ IPAddress = '172.20.0.1'; PrefixLength = 20 }) }
        $Result.ok | Should -BeTrue
        @($Result.addresses).Count | Should -Be 1
        $Result.addresses[0] | Should -Be '172.20.1.8'
    }

    It 'rejects a bootstrap adapter on a foreign switch' {
        $Vm = [pscustomobject]@{ Id = [Guid]'12345678-1234-1234-1234-123456789abc' }
        {
            Get-CccLinuxBootstrapNetworkResult -Vm $Vm `
                -VmAdapterReader { param($TargetVm) @([pscustomobject]@{ Name = 'CCC Bootstrap DHCP'; SwitchName = 'Foreign'; IPAddresses = @() }) }
        } | Should -Throw 'hyper-v-bootstrap-network-adapter-identity-mismatch'
    }
}

Describe 'CCC Hyper-V guest boot diagnostic operation' {
    It 'returns Generation 1 heartbeat, disk, media, and boot-order evidence' {
        $Vm = [pscustomobject]@{
            Id = [Guid]'12345678-1234-1234-1234-123456789abc'
            Name = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
            State = 'Running'
            Uptime = [TimeSpan]::FromSeconds(30)
            Generation = 1
        }
        $Result = Get-CccGuestBootDiagnosticResult -Vm $Vm `
            -IntegrationServiceReader { param($TargetVm) @([pscustomobject]@{ Id = [Guid]'84eaae65-2f2e-45f5-9bb5-0e857dc8eb47'; Name = 'Heartbeat'; Enabled = $true; PrimaryStatus = 2; SecondaryStatus = 0 }) } `
            -BiosReader { param($TargetVm) [pscustomobject]@{ StartupOrder = @('IDE', 'CD') } } `
            -HardDiskReader { param($TargetVm) @([pscustomobject]@{ ControllerType = 'IDE'; ControllerNumber = 0; ControllerLocation = 0; Path = 'C:\disk.vhdx' }) } `
            -DvdReader { param($TargetVm) @([pscustomobject]@{ ControllerType = 'IDE'; ControllerNumber = 1; ControllerLocation = 0; Path = 'C:\seed.iso' }, [pscustomobject]@{ ControllerType = 'IDE'; ControllerNumber = 1; ControllerLocation = 1; Path = $null }) } `
            -VhdReader { param($Path) [pscustomobject]@{ VhdFormat = 'VHDX'; VhdType = 'Dynamic'; Size = 32GB; FileSize = 4GB; MinimumSize = 3GB; LogicalSectorSize = 512; PhysicalSectorSize = 4096 } }
        $Result.ok | Should -BeTrue
        $Result.heartbeatEnabled | Should -BeTrue
        $Result.heartbeatPrimaryStatus | Should -Be 2
        $Result.hardDiskCount | Should -Be 1
        $Result.dvdCount | Should -Be 2
        $Result.hardDiskControllers[0] | Should -Be 'ide'
        @($Result.bootDeviceTypes).Count | Should -Be 2
        $Result.bootDeviceTypes[0] | Should -Be 'hard-disk'
        $Result.bootDeviceTypes[1] | Should -Be 'dvd'
        $Result.hardDisks[0].vhdFormat | Should -Be 'VHDX'
        $Result.hardDisks[0].sizeBytes | Should -Be 32GB
        $Result.dvdDrives[0].mediaAttached | Should -BeTrue
        $Result.dvdDrives[1].mediaAttached | Should -BeFalse
        $Result.diagnosticComplete | Should -BeTrue
        @($Result.diagnosticErrors).Count | Should -Be 0
    }

    It 'normalizes Hyper-V OnOffState firmware values without degrading diagnostics' {
        $Vm = [pscustomobject]@{
            Id = [Guid]'12345678-1234-1234-1234-123456789abc'
            Name = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
            State = 'Running'
            Uptime = [TimeSpan]::FromSeconds(30)
            Generation = 2
        }
        $Result = Get-CccGuestBootDiagnosticResult -Vm $Vm `
            -IntegrationServiceReader { @([pscustomobject]@{ Id = [Guid]'84eaae65-2f2e-45f5-9bb5-0e857dc8eb47'; Name = 'Heartbeat'; Enabled = 'On'; PrimaryStatus = 2; SecondaryStatus = 0 }) } `
            -FirmwareReader { [pscustomobject]@{ SecureBoot = 'On'; BootOrder = @([pscustomobject]@{ BootType = 'Drive'; Device = [pscustomobject]@{ Type = 'Vhd' } }) } } `
            -HardDiskReader { @([pscustomobject]@{ ControllerType = 'SCSI'; ControllerNumber = 0; ControllerLocation = 0; Path = 'C:\disk.vhdx' }) } `
            -DvdReader { @() } `
            -VhdReader { [pscustomobject]@{ VhdFormat = 'VHDX'; VhdType = 'Dynamic'; Size = 32GB; FileSize = 4GB; MinimumSize = 3GB; LogicalSectorSize = 512; PhysicalSectorSize = 4096 } }

        $Result.secureBootEnabled | Should -BeTrue
        $Result.heartbeatEnabled | Should -BeTrue
        @($Result.diagnosticErrors) | Should -Not -Contain 'hyper-v-diagnostic-firmware-incomplete'
        @($Result.diagnosticErrors) | Should -Not -Contain 'hyper-v-diagnostic-integration-services-incomplete'
    }

    It 'returns bounded partial evidence when optional Hyper-V readers fail' {
        $Vm = [pscustomobject]@{
            Id = [Guid]'12345678-1234-1234-1234-123456789abc'
            Name = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
            State = 'Running'
            Uptime = [TimeSpan]::FromSeconds(30)
            Generation = 2
        }
        $Result = Get-CccGuestBootDiagnosticResult -Vm $Vm `
            -IntegrationServiceReader { throw 'private integration failure' } `
            -FirmwareReader { throw 'private firmware failure' } `
            -HardDiskReader { throw 'private disk failure' } `
            -DvdReader { throw 'private dvd failure' }

        $Result.ok | Should -BeTrue
        $Result.state | Should -Be 'Running'
        $Result.generation | Should -Be 2
        $Result.uptimeMs | Should -Be 30000
        $Result.diagnosticComplete | Should -BeFalse
        @($Result.diagnosticErrors) | Should -Be @(
            'hyper-v-diagnostic-integration-services-unavailable',
            'hyper-v-diagnostic-firmware-unavailable',
            'hyper-v-diagnostic-hard-disks-unavailable',
            'hyper-v-diagnostic-dvd-drives-unavailable'
        )
        ($Result | ConvertTo-Json -Depth 8) | Should -Not -Match 'private'
    }

    It 'returns bounded disk evidence when VHD inspection fails' {
        $Vm = [pscustomobject]@{
            Id = [Guid]'12345678-1234-1234-1234-123456789abc'
            Name = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111'
            State = 'Running'
            Uptime = [TimeSpan]::FromSeconds(30)
            Generation = 1
        }
        $Result = Get-CccGuestBootDiagnosticResult -Vm $Vm `
            -IntegrationServiceReader { @([pscustomobject]@{ Id = [Guid]'84eaae65-2f2e-45f5-9bb5-0e857dc8eb47'; Name = 'Heartbeat'; Enabled = $true; PrimaryStatus = 2; SecondaryStatus = 0 }) } `
            -BiosReader { [pscustomobject]@{ StartupOrder = @('IDE') } } `
            -HardDiskReader { @([pscustomobject]@{ ControllerType = 'IDE'; ControllerNumber = 0; ControllerLocation = 0; Path = 'C:\secret-disk.vhdx' }) } `
            -DvdReader { @() } `
            -VhdReader { throw 'private VHD inspection failure' }

        $Result.ok | Should -BeTrue
        $Result.hardDiskCount | Should -Be 1
        $Result.hardDisks[0].controllerType | Should -Be 'ide'
        $Result.hardDisks[0].vhdFormat | Should -Be ''
        $Result.diagnosticComplete | Should -BeFalse
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-vhd-inspection-incomplete'
        ($Result | ConvertTo-Json -Depth 8) | Should -Not -Match 'private|secret-disk|C:\\'
    }

    It 'survives sparse VM and reader objects under strict mode' {
        $Vm = [pscustomobject]@{
            Id = [Guid]'12345678-1234-1234-1234-123456789abc'
            Name = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
        }
        $Result = Get-CccGuestBootDiagnosticResult -Vm $Vm `
            -IntegrationServiceReader { @([pscustomobject]@{}) } `
            -HardDiskReader { @([pscustomobject]@{}) } `
            -DvdReader { @() }

        $Result.ok | Should -BeTrue
        $Result.state | Should -Be 'Unknown'
        $Result.generation | Should -BeNullOrEmpty
        $Result.diagnosticComplete | Should -BeFalse
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-vm-observation-incomplete'
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-integration-services-incomplete'
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-hard-disks-incomplete'
    }

    It 'contains throwing CIM-style property getters without leaking their errors' {
        $Vm = [pscustomobject]@{
            Id = [Guid]'12345678-1234-1234-1234-123456789abc'
            Name = 'ccc-0123456789abcdef-linux-ci-01-11111111111111111111111111111111'
            State = 'Running'
            Generation = 2
        }
        $Vm | Add-Member -MemberType ScriptProperty -Name Uptime -Value { throw 'private uptime failure' }
        $Service = [pscustomobject]@{
            Id = [Guid]'84eaae65-2f2e-45f5-9bb5-0e857dc8eb47'
            Name = 'Heartbeat'
            PrimaryStatus = 2
            SecondaryStatus = 0
        }
        $Service | Add-Member -MemberType ScriptProperty -Name Enabled -Value { throw 'private service failure' }
        $Firmware = [pscustomobject]@{ SecureBoot = $true }
        $Firmware | Add-Member -MemberType ScriptProperty -Name BootOrder -Value { throw 'private firmware failure' }
        $Disk = [pscustomobject]@{}
        $Disk | Add-Member -MemberType ScriptProperty -Name ControllerType -Value { throw 'private disk failure' }
        $IntegrationServiceReader = { param($TargetVm) @($Service) }.GetNewClosure()
        $FirmwareReader = { param($TargetVm) $Firmware }.GetNewClosure()
        $HardDiskReader = { param($TargetVm) @($Disk) }.GetNewClosure()

        $Result = Get-CccGuestBootDiagnosticResult -Vm $Vm `
            -IntegrationServiceReader $IntegrationServiceReader `
            -FirmwareReader $FirmwareReader `
            -HardDiskReader $HardDiskReader `
            -DvdReader { @() }

        $Result.ok | Should -BeTrue
        $Result.diagnosticComplete | Should -BeFalse
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-vm-observation-incomplete'
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-integration-services-incomplete'
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-firmware-incomplete'
        @($Result.diagnosticErrors) | Should -Contain 'hyper-v-diagnostic-hard-disks-incomplete'
        ($Result | ConvertTo-Json -Depth 8) | Should -Not -Match 'private'
    }
}
