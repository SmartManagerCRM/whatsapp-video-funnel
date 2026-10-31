using System.Text.Json;

namespace SmartManager.Licensing;

/// <summary>Local issued-license register (a JSON file per key profile). Writes are atomic.</summary>
public sealed class IssuedRegister
{
    private readonly string _path;
    private static readonly JsonSerializerOptions Opts = new() { WriteIndented = true };

    public IssuedRegister(string rootDir, string profile)
    {
        var dir = Path.Combine(rootDir, "register"); Directory.CreateDirectory(dir);
        _path = Path.Combine(dir, $"issued-licenses.{profile}.json");
    }

    public List<IssuedLicense> All() =>
        File.Exists(_path) ? JsonSerializer.Deserialize<List<IssuedLicense>>(File.ReadAllText(_path)) ?? new() : new();

    public void Add(IssuedLicense l)
    {
        var all = All();
        if (all.Any(x => x.LicenseId == l.LicenseId)) throw new InvalidOperationException("License ID already registered");
        all.Add(l); Save(all);
    }

    public void SetStatus(string licenseId, string status, string? note = null)
    {
        var all = All(); var l = all.FirstOrDefault(x => x.LicenseId == licenseId) ?? throw new KeyNotFoundException(licenseId);
        l.Status = status; if (note is not null) l.Notes = note; Save(all);
    }

    private void Save(List<IssuedLicense> all)
    {
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(all, Opts));
        File.Move(tmp, _path, overwrite: true);
    }
}

/// <summary>Creates licenses and records them. The only place where payloads are assembled.</summary>
public sealed class LicenseIssuer
{
    private readonly KeyStore _keys; private readonly IssuedRegister _register;
    public LicenseIssuer(KeyStore keys, IssuedRegister register) { _keys = keys; _register = register; }

    public IssuedLicense Issue(string clientName, string tenantId, string tenantSlug, IEnumerable<string> features, int maxNumbers = 1, string? transferFrom = null, DateTimeOffset? now = null)
    {
        var payload = new LicensePayload
        {
            LicenseId = LicenseSigner.NewLicenseId(), ClientName = clientName.Trim(), TenantId = tenantId.Trim(), TenantSlug = tenantSlug.Trim().ToLowerInvariant(),
            IssuedAt = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds(), Type = LicensePayload.Lifetime, Expires = null,
            Features = features.Distinct().OrderBy(x => x).ToList(), MaxNumbers = maxNumbers, TransferFrom = string.IsNullOrWhiteSpace(transferFrom) ? null : transferFrom.Trim(),
        };
        using var priv = _keys.LoadPrivate();
        var token = LicenseSigner.Sign(payload, priv);
        var rec = new IssuedLicense
        {
            LicenseId = payload.LicenseId, ClientName = payload.ClientName, TenantId = payload.TenantId, TenantSlug = payload.TenantSlug, Type = payload.Type,
            Features = payload.Features, MaxNumbers = payload.MaxNumbers, IssuedAt = DateTimeOffset.FromUnixTimeSeconds(payload.IssuedAt),
            KeyFingerprint = _keys.Fingerprint(), KeyProfile = _keys.Profile, TransferFrom = payload.TransferFrom, Token = token,
        };
        _register.Add(rec);
        return rec;
    }
}
