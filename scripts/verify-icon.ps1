param([string]$Executable = 'src-tauri/target/debug/app.exe')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$executablePath = if ([System.IO.Path]::IsPathRooted($Executable)) { $Executable } else { Join-Path $projectRoot $Executable }
$sourceIcon = [System.IO.File]::ReadAllBytes((Join-Path $projectRoot 'src-tauri/icons/icon.ico'))
$script:expectedIcons = @{}
for ($index = 0; $index -lt [BitConverter]::ToUInt16($sourceIcon, 4); $index++) {
    $entry = 6 + $index * 16
    $size = if ($sourceIcon[$entry] -eq 0) { 256 } else { [int]$sourceIcon[$entry] }
    $offset = [BitConverter]::ToUInt32($sourceIcon, $entry + 12)
    $length = [BitConverter]::ToUInt32($sourceIcon, $entry + 8)
    $script:expectedIcons[$size] = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([byte[]]$sourceIcon[$offset..($offset + $length - 1)]))
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InfoHubResources {
    public delegate bool EnumName(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumName callback, IntPtr param);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
    public static byte[] Bytes(IntPtr module, IntPtr name, int type) {
        var resource = FindResource(module, name, new IntPtr(type));
        if (resource == IntPtr.Zero) throw new Exception("Icon resource missing");
        byte[] data = new byte[SizeofResource(module, resource)];
        Marshal.Copy(LockResource(LoadResource(module, resource)), data, 0, data.Length);
        return data;
    }
}
'@

# Load only PE resources; this never launches the application or uses the shell icon cache.
$module = [InfoHubResources]::LoadLibraryEx($executablePath, [IntPtr]::Zero, 34)
if ($module -eq [IntPtr]::Zero) { throw "Cannot read executable resources: $executablePath" }
$script:verifiedFrames = 0
$script:iconErrors = [System.Collections.Generic.List[string]]::new()
try {
    $callback = [InfoHubResources+EnumName] {
        param($moduleHandle, $type, $name, $unused)
        $group = [InfoHubResources]::Bytes($moduleHandle, $name, 14)
        $count = [BitConverter]::ToUInt16($group, 4)
        if ($count -ne $script:expectedIcons.Count) { $script:iconErrors.Add("Frame count mismatch: $count") }
        for ($frame = 0; $frame -lt $count; $frame++) {
            $entry = 6 + $frame * 14
            $size = if ($group[$entry] -eq 0) { 256 } else { [int]$group[$entry] }
            $id = [BitConverter]::ToUInt16($group, $entry + 12)
            $bytes = [InfoHubResources]::Bytes($moduleHandle, [IntPtr]::new($id), 3)
            $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes))
            if ($hash -ne $script:expectedIcons[$size]) { $script:iconErrors.Add("Embedded ${size}px icon differs from source") }
            $script:verifiedFrames++
        }
        return $true
    }
    [void][InfoHubResources]::EnumResourceNames($module, [IntPtr]::new(14), $callback, [IntPtr]::Zero)
} finally { [void][InfoHubResources]::FreeLibrary($module) }
if ($script:verifiedFrames -ne $script:expectedIcons.Count -or $script:iconErrors.Count) {
    throw "Icon verification failed: $($script:iconErrors -join '; ')"
}
Write-Output "Verified $script:verifiedFrames embedded icon frames against source ICO: 16, 24, 32, 48, 64, 128, 256 px."
