using System.ComponentModel;
using System.Runtime.InteropServices;
using SmartManager.Licensing;

namespace SmartManager.LicenseGenerator;

/// <summary>
/// Protects the signing key with Windows DPAPI (CurrentUser scope): the key file can only be decrypted by this
/// Windows account on this machine. Implemented with P/Invoke so no extra NuGet package is required.
/// </summary>
public sealed class DpapiKeyProtector : IKeyProtector
{
    private static readonly byte[] Entropy = System.Text.Encoding.UTF8.GetBytes("SmartManager.LicenseGenerator/v1");

    [StructLayout(LayoutKind.Sequential)] private struct DataBlob { public int cbData; public IntPtr pbData; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(ref DataBlob pDataIn, string? szDataDescr, ref DataBlob pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, out DataBlob pDataOut);
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(ref DataBlob pDataIn, IntPtr ppszDataDescr, ref DataBlob pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, out DataBlob pDataOut);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr hMem);

    private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    public byte[] Protect(byte[] data) => Run(data, protect: true);
    public byte[] Unprotect(byte[] data) => Run(data, protect: false);

    private static byte[] Run(byte[] input, bool protect)
    {
        var inPtr = Marshal.AllocHGlobal(input.Length); var entPtr = Marshal.AllocHGlobal(Entropy.Length);
        try
        {
            Marshal.Copy(input, 0, inPtr, input.Length); Marshal.Copy(Entropy, 0, entPtr, Entropy.Length);
            var inBlob = new DataBlob { cbData = input.Length, pbData = inPtr };
            var entBlob = new DataBlob { cbData = Entropy.Length, pbData = entPtr };
            DataBlob o1;
            var ok = protect
                ? CryptProtectData(ref inBlob, "SmartManager signing key", ref entBlob, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out o1)
                : CryptUnprotectData(ref inBlob, IntPtr.Zero, ref entBlob, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out o1);
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { var result = new byte[o1.cbData]; Marshal.Copy(o1.pbData, result, 0, o1.cbData); return result; }
            finally { LocalFree(o1.pbData); }
        }
        finally { Marshal.FreeHGlobal(inPtr); Marshal.FreeHGlobal(entPtr); }
    }
}
