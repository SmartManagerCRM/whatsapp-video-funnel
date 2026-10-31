using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SmartManager.Licensing;

/// <summary>
/// Produces and verifies compact JWS tokens (RS256 = RSASSA-PKCS1-v1_5 + SHA-256):
///   base64url(header) . base64url(payload) . base64url(signature)
/// The .smlic file is JSON: { "format": "smlic/1", "token": "..." }.
/// </summary>
public static class LicenseSigner
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    public static string Sign(LicensePayload payload, RSA privateKey)
    {
        Validate(payload);
        var header = B64Url(JsonSerializer.SerializeToUtf8Bytes(new { alg = "RS256", typ = "SMLIC" }, Json));
        var body = B64Url(JsonSerializer.SerializeToUtf8Bytes(payload, Json));
        var signingInput = Encoding.ASCII.GetBytes($"{header}.{body}");
        var sig = privateKey.SignData(signingInput, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{body}.{B64Url(sig)}";
    }

    public static bool TryVerify(string token, RSA publicKey, out LicensePayload? payload)
    {
        payload = null;
        var parts = token.Trim().Split('.');
        if (parts.Length != 3) return false;
        try
        {
            var ok = publicKey.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), FromB64Url(parts[2]),
                HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            if (!ok) return false;
            payload = JsonSerializer.Deserialize<LicensePayload>(FromB64Url(parts[1]));
            return payload is not null;
        }
        catch (Exception e) when (e is FormatException or JsonException or CryptographicException) { return false; }
    }

    public static LicensePayload? DecodeUnverified(string token)
    {
        var parts = token.Trim().Split('.');
        if (parts.Length != 3) return null;
        try { return JsonSerializer.Deserialize<LicensePayload>(FromB64Url(parts[1])); } catch { return null; }
    }

    public static string ToSmlic(string token) =>
        JsonSerializer.Serialize(new { format = "smlic/1", token }, new JsonSerializerOptions { WriteIndented = true });

    public static string NewLicenseId() => "lic_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();

    public static void Validate(LicensePayload p)
    {
        if (string.IsNullOrWhiteSpace(p.LicenseId)) throw new ArgumentException("License ID is required");
        if (string.IsNullOrWhiteSpace(p.ClientName)) throw new ArgumentException("Client name is required");
        if (string.IsNullOrWhiteSpace(p.TenantId)) throw new ArgumentException("Tenant ID is required");
        if (!System.Text.RegularExpressions.Regex.IsMatch(p.TenantSlug, "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$"))
            throw new ArgumentException("Tenant slug must be 3-40 characters: lowercase letters, digits and hyphens");
        if (p.Type == LicensePayload.Lifetime)
        {
            if (p.Expires is not null) throw new ArgumentException("A LIFETIME license must not have an expiration date");
        }
        else if (p.Type == LicensePayload.Limited)
        {
            if (p.Expires is null) throw new ArgumentException("A LIMITED license needs an expiration date");
            if (p.Expires <= p.IssuedAt) throw new ArgumentException("The expiration date must be after the issue date");
            if (p.Expires > p.IssuedAt + MaxLimitedSeconds) throw new ArgumentException("A limited-time license cannot run for more than 20 years; use LIFETIME instead");
        }
        else throw new ArgumentException($"Unsupported license type '{p.Type}'. Use LIFETIME or LIMITED");
        if (p.Renews is not null && (p.Renews == p.LicenseId || p.TransferFrom is not null))
            throw new ArgumentException("A license cannot renew itself, and cannot be both a renewal and a transfer");
        if (p.MaxNumbers < 1) throw new ArgumentException("At least one WhatsApp number must be authorised");
    }

    private const long MaxLimitedSeconds = 20L * 366 * 24 * 3600;

    public static string B64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static byte[] FromB64Url(string s)
    {
        s = s.Replace('-', '+').Replace('_', '/');
        s = s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=');
        return Convert.FromBase64String(s);
    }
}
