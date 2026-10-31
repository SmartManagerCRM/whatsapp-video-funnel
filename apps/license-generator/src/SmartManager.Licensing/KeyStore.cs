using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SmartManager.Licensing;

/// <summary>Protects private-key bytes at rest. The Windows app uses DPAPI; tests use a fake.</summary>
public interface IKeyProtector
{
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

/// <summary>
/// Stores the signing key pair for one profile ("development" or "production") under its own folder.
/// The private key never leaves this machine unencrypted: it is DPAPI-protected on disk and only
/// exported as a passphrase-encrypted backup. Keys are never hardcoded or generated at build time.
/// </summary>
public sealed class KeyStore
{
    private readonly string _dir;
    private readonly IKeyProtector _protector;
    public string Profile { get; }

    public KeyStore(string rootDir, string profile, IKeyProtector protector)
    {
        if (profile is not ("development" or "production")) throw new ArgumentException("Profile must be development or production");
        Profile = profile; _protector = protector;
        _dir = Path.Combine(rootDir, "keys", profile);
        Directory.CreateDirectory(_dir);
    }

    private string PrivatePath => Path.Combine(_dir, "signing-key.protected");
    private string PublicPath => Path.Combine(_dir, "public-key.pem");

    public bool HasKey => File.Exists(PrivatePath);

    public void Generate(int bits = 3072)
    {
        if (HasKey) throw new InvalidOperationException("A key already exists for this profile. Back it up and delete it explicitly before generating a new one.");
        using var rsa = RSA.Create(bits);
        Store(rsa);
    }

    private void Store(RSA rsa)
    {
        File.WriteAllBytes(PrivatePath, _protector.Protect(rsa.ExportPkcs8PrivateKey()));
        File.WriteAllText(PublicPath, rsa.ExportSubjectPublicKeyInfoPem());
    }

    public RSA LoadPrivate()
    {
        if (!HasKey) throw new InvalidOperationException("No signing key for this profile. Generate or import one in Key Management.");
        var rsa = RSA.Create();
        rsa.ImportPkcs8PrivateKey(_protector.Unprotect(File.ReadAllBytes(PrivatePath)), out _);
        return rsa;
    }

    /// <summary>PEM to paste into the Worker secret LICENSE_PUBLIC_KEY (wrangler secret put).</summary>
    public string PublicKeyPem() => File.ReadAllText(PublicPath);

    public RSA LoadPublic()
    {
        var rsa = RSA.Create();
        rsa.ImportFromPem(PublicKeyPem());
        return rsa;
    }

    /// <summary>Short SHA-256 fingerprint of the public key (SPKI DER), shown so keys can be told apart.</summary>
    public string Fingerprint()
    {
        using var rsa = LoadPublic();
        var hash = SHA256.HashData(rsa.ExportSubjectPublicKeyInfo());
        return Convert.ToHexString(hash)[..32].ToLowerInvariant();
    }

    // ---- passphrase-encrypted backup (PBKDF2-SHA256 600k + AES-256-GCM)
    public string ExportBackup(string passphrase)
    {
        if (passphrase.Length < 12) throw new ArgumentException("Use a passphrase of at least 12 characters");
        using var rsa = LoadPrivate();
        var salt = RandomNumberGenerator.GetBytes(16); var nonce = RandomNumberGenerator.GetBytes(12);
        var key = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(passphrase), salt, 600_000, HashAlgorithmName.SHA256, 32);
        var plain = rsa.ExportPkcs8PrivateKey(); var ct = new byte[plain.Length]; var tag = new byte[16];
        using (var gcm = new AesGcm(key, 16)) gcm.Encrypt(nonce, plain, ct, tag, Encoding.ASCII.GetBytes($"smartmanager-key-backup/{Profile}"));
        CryptographicOperations.ZeroMemory(plain); CryptographicOperations.ZeroMemory(key);
        return JsonSerializer.Serialize(new { format = "smartmanager-key-backup/1", profile = Profile, kdf = "pbkdf2-sha256", iterations = 600_000,
            salt = Convert.ToBase64String(salt), nonce = Convert.ToBase64String(nonce), tag = Convert.ToBase64String(tag), data = Convert.ToBase64String(ct) },
            new JsonSerializerOptions { WriteIndented = true });
    }

    public void ImportBackup(string json, string passphrase)
    {
        if (HasKey) throw new InvalidOperationException("A key already exists for this profile.");
        using var doc = JsonDocument.Parse(json); var r = doc.RootElement;
        if (r.GetProperty("format").GetString() != "smartmanager-key-backup/1") throw new InvalidDataException("Not a SmartManager key backup");
        if (r.GetProperty("profile").GetString() != Profile) throw new InvalidDataException($"This backup belongs to the '{r.GetProperty("profile").GetString()}' profile");
        var salt = Convert.FromBase64String(r.GetProperty("salt").GetString()!);
        var key = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(passphrase), salt, r.GetProperty("iterations").GetInt32(), HashAlgorithmName.SHA256, 32);
        var ct = Convert.FromBase64String(r.GetProperty("data").GetString()!); var plain = new byte[ct.Length];
        try { using var gcm = new AesGcm(key, 16); gcm.Decrypt(Convert.FromBase64String(r.GetProperty("nonce").GetString()!), ct, Convert.FromBase64String(r.GetProperty("tag").GetString()!), plain, Encoding.ASCII.GetBytes($"smartmanager-key-backup/{Profile}")); }
        catch (CryptographicException) { throw new InvalidDataException("Wrong passphrase or damaged backup"); }
        using var rsa = RSA.Create(); rsa.ImportPkcs8PrivateKey(plain, out _);
        CryptographicOperations.ZeroMemory(plain); CryptographicOperations.ZeroMemory(key);
        Store(rsa);
    }
}
