using System.Security.Cryptography;
using System.Text.Json;
using SmartManager.Licensing;
using Xunit;

namespace SmartManager.Licensing.Tests;

/// <summary>Not secure: only for tests. The Windows app uses DPAPI.</summary>
file sealed class XorProtector : IKeyProtector
{
    public byte[] Protect(byte[] d) => d.Select(b => (byte)(b ^ 0x5A)).ToArray();
    public byte[] Unprotect(byte[] d) => Protect(d);
}

public class LicensingTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "smlg-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(_root, true); } catch { } }

    private KeyStore NewKeys(string profile = "development") { var k = new KeyStore(_root, profile, new XorProtector()); k.Generate(2048); return k; }

    [Fact]
    public void Issued_license_is_lifetime_without_expiry_and_verifies()
    {
        var keys = NewKeys(); var issuer = new LicenseIssuer(keys, new IssuedRegister(_root, "development"));
        var rec = issuer.Issue("Acme Café", "tnt_abc", "acme-cafe", new[] { "video-funnel", "coexistence" });
        using var pub = keys.LoadPublic();
        Assert.True(LicenseSigner.TryVerify(rec.Token, pub, out var p));
        Assert.Equal("LIFETIME", p!.Type); Assert.Null(p.Expires); Assert.Equal(1, p.MaxNumbers);
        using var doc = JsonDocument.Parse(LicenseSigner.FromB64Url(rec.Token.Split('.')[1]));
        Assert.False(doc.RootElement.TryGetProperty("exp", out _)); // key absent entirely, as the Worker expects
        Assert.Equal("smartmanager-whatsapp-video-funnel", doc.RootElement.GetProperty("pid").GetString());
        Assert.Equal("acme-cafe", doc.RootElement.GetProperty("tenant_slug").GetString());
    }

    [Fact]
    public void Tampering_or_wrong_key_fails_verification()
    {
        var keys = NewKeys(); var rec = new LicenseIssuer(keys, new IssuedRegister(_root, "development")).Issue("A", "tnt_1", "client-a", new[] { "video-funnel" });
        var parts = rec.Token.Split('.'); var forged = JsonSerializer.Deserialize<LicensePayload>(LicenseSigner.FromB64Url(parts[1]))!; forged.MaxNumbers = 50;
        var tampered = $"{parts[0]}.{LicenseSigner.B64Url(JsonSerializer.SerializeToUtf8Bytes(forged))}.{parts[2]}";
        using var pub = keys.LoadPublic(); using var other = RSA.Create(2048);
        Assert.False(LicenseSigner.TryVerify(tampered, pub, out _));
        Assert.False(LicenseSigner.TryVerify(rec.Token, other, out _));
        Assert.False(LicenseSigner.TryVerify("garbage", pub, out _));
    }

    [Fact]
    public void Validation_rejects_expiry_non_lifetime_and_bad_slug()
    {
        var keys = NewKeys(); using var priv = keys.LoadPrivate();
        LicensePayload Ok() => new() { LicenseId = "lic_1", ClientName = "A", TenantId = "t", TenantSlug = "client-a", IssuedAt = 1 };
        Assert.Throws<ArgumentException>(() => LicenseSigner.Sign(new LicensePayload { LicenseId = "lic_1", ClientName = "A", TenantId = "t", TenantSlug = "client-a", IssuedAt = 1, Expires = 99 }, priv));
        var annual = Ok(); annual.Type = "ANNUAL"; Assert.Throws<ArgumentException>(() => LicenseSigner.Sign(annual, priv));
        var bad = Ok(); bad.TenantSlug = "Bad Slug"; Assert.Throws<ArgumentException>(() => LicenseSigner.Sign(bad, priv));
        var zero = Ok(); zero.MaxNumbers = 0; Assert.Throws<ArgumentException>(() => LicenseSigner.Sign(zero, priv));
    }

    [Fact]
    public void Register_records_licenses_and_status_and_rejects_duplicates()
    {
        var keys = NewKeys(); var reg = new IssuedRegister(_root, "development"); var issuer = new LicenseIssuer(keys, reg);
        var a = issuer.Issue("A", "tnt_1", "client-a", new[] { "video-funnel" }); issuer.Issue("B", "tnt_2", "client-b", new[] { "video-funnel" });
        Assert.Equal(2, reg.All().Count);
        reg.SetStatus(a.LicenseId, "Transferred", "to client-b");
        Assert.Equal("Transferred", reg.All().First(x => x.LicenseId == a.LicenseId).Status);
        Assert.Throws<InvalidOperationException>(() => reg.Add(a));
        Assert.Equal(keys.Fingerprint(), a.KeyFingerprint);
    }

    [Fact]
    public void Transfer_license_carries_transfer_from()
    {
        var keys = NewKeys(); var issuer = new LicenseIssuer(keys, new IssuedRegister(_root, "development"));
        var old = issuer.Issue("A", "tnt_1", "client-a", new[] { "video-funnel" });
        var moved = issuer.Issue("A", "tnt_2", "client-b", new[] { "video-funnel" }, transferFrom: old.LicenseId);
        Assert.Equal(old.LicenseId, LicenseSigner.DecodeUnverified(moved.Token)!.TransferFrom);
    }

    [Fact]
    public void Key_backup_round_trips_and_wrong_passphrase_fails()
    {
        var keys = NewKeys("production"); var backup = keys.ExportBackup("correct horse battery staple");
        Assert.DoesNotContain("PRIVATE", backup);
        var other = new KeyStore(Path.Combine(_root, "restore"), "production", new XorProtector());
        Assert.Throws<InvalidDataException>(() => other.ImportBackup(backup, "wrong passphrase value"));
        other.ImportBackup(backup, "correct horse battery staple");
        Assert.Equal(keys.Fingerprint(), other.Fingerprint());
        // a development key can't be restored into the production slot and vice versa
        var dev = new KeyStore(Path.Combine(_root, "r2"), "development", new XorProtector());
        Assert.Throws<InvalidDataException>(() => dev.ImportBackup(backup, "correct horse battery staple"));
        Assert.Throws<ArgumentException>(() => keys.ExportBackup("short"));
    }

    [Fact]
    public void Generating_over_an_existing_key_is_refused_and_profiles_are_separate()
    {
        var dev = NewKeys("development"); Assert.Throws<InvalidOperationException>(() => dev.Generate(2048));
        var prod = new KeyStore(_root, "production", new XorProtector()); Assert.False(prod.HasKey);
        prod.Generate(2048); Assert.NotEqual(dev.Fingerprint(), prod.Fingerprint());
    }

    [Fact]
    public void Smlic_file_wraps_the_token()
    {
        using var doc = JsonDocument.Parse(LicenseSigner.ToSmlic("a.b.c"));
        Assert.Equal("smlic/1", doc.RootElement.GetProperty("format").GetString()); Assert.Equal("a.b.c", doc.RootElement.GetProperty("token").GetString());
    }

    private static readonly DateTimeOffset T0 = new(2026, 1, 15, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Limited_license_carries_an_expiry_and_lifetime_still_has_none()
    {
        var keys = NewKeys(); var issuer = new LicenseIssuer(keys, new IssuedRegister(_root, "development"));
        var ltd = issuer.Issue("A", "tnt_1", "client-a", new[] { "video-funnel" }, now: T0, type: "LIMITED", expiresAt: T0.AddYears(1));
        using var pub = keys.LoadPublic();
        Assert.True(LicenseSigner.TryVerify(ltd.Token, pub, out var p));
        Assert.Equal("LIMITED", p!.Type); Assert.Equal(T0.AddYears(1).ToUnixTimeSeconds(), p.Expires);
        Assert.Equal(T0.AddYears(1), ltd.ExpiresAt); Assert.Equal("2027-01-15", ltd.ExpiresDisplay);
        var life = issuer.Issue("B", "tnt_2", "client-b", new[] { "video-funnel" }, now: T0);
        using var doc = JsonDocument.Parse(LicenseSigner.FromB64Url(life.Token.Split('.')[1]));
        Assert.Equal("LIFETIME", doc.RootElement.GetProperty("type").GetString()); Assert.False(doc.RootElement.TryGetProperty("exp", out _));
        Assert.Equal("never", life.ExpiresDisplay); Assert.Null(life.DaysLeft);
    }

    [Fact]
    public void Validation_enforces_expiry_rules_per_type()
    {
        var keys = NewKeys(); var issuer = new LicenseIssuer(keys, new IssuedRegister(_root, "development"));
        Assert.Throws<ArgumentException>(() => issuer.Issue("A", "t", "client-a", new[] { "f" }, now: T0, type: "LIMITED"));                                   // no expiry
        Assert.Throws<ArgumentException>(() => issuer.Issue("A", "t", "client-a", new[] { "f" }, now: T0, type: "LIMITED", expiresAt: T0));                    // not after issue date
        Assert.Throws<ArgumentException>(() => issuer.Issue("A", "t", "client-a", new[] { "f" }, now: T0, type: "LIMITED", expiresAt: T0.AddDays(-1)));       // in the past
        Assert.Throws<ArgumentException>(() => issuer.Issue("A", "t", "client-a", new[] { "f" }, now: T0, type: "LIMITED", expiresAt: T0.AddYears(25)));      // > 20 years
        Assert.Throws<ArgumentException>(() => issuer.Issue("A", "t", "client-a", new[] { "f" }, now: T0, type: "LIFETIME", expiresAt: T0.AddYears(1)));      // lifetime with a date
        Assert.Throws<ArgumentException>(() => issuer.Issue("A", "t", "client-a", new[] { "f" }, now: T0, type: "ANNUAL", expiresAt: T0.AddYears(1)));        // unknown type
        Assert.Empty(new IssuedRegister(_root, "development").All());                                                                                           // nothing registered on failure
    }

    [Fact]
    public void Renewal_extends_a_limited_license_and_marks_the_old_one()
    {
        var keys = NewKeys(); var reg = new IssuedRegister(_root, "development"); var issuer = new LicenseIssuer(keys, reg);
        var old = issuer.Issue("A", "tnt_1", "client-a", new[] { "video-funnel" }, now: T0, type: "LIMITED", expiresAt: T0.AddMonths(3));
        var renewed = issuer.Renew(old, T0.AddYears(1), now: T0.AddMonths(2));
        var claims = LicenseSigner.DecodeUnverified(renewed.Token)!;
        Assert.Equal(old.LicenseId, claims.Renews); Assert.Equal("LIMITED", claims.Type); Assert.Equal(T0.AddYears(1).ToUnixTimeSeconds(), claims.Expires);
        Assert.Equal("tnt_1", claims.TenantId); Assert.Equal("client-a", claims.TenantSlug);
        Assert.Equal("Renewed", reg.All().First(x => x.LicenseId == old.LicenseId).Status);
        Assert.Throws<InvalidOperationException>(() => issuer.Renew(reg.All().First(x => x.LicenseId == old.LicenseId), T0.AddYears(2))); // already renewed
    }

    [Fact]
    public void Upgrade_to_lifetime_has_no_expiry_and_a_lifetime_license_cannot_be_renewed()
    {
        var keys = NewKeys(); var reg = new IssuedRegister(_root, "development"); var issuer = new LicenseIssuer(keys, reg);
        var old = issuer.Issue("A", "tnt_1", "client-a", new[] { "video-funnel" }, now: T0, type: "LIMITED", expiresAt: T0.AddMonths(1));
        var up = issuer.Renew(old, null, now: T0);
        var claims = LicenseSigner.DecodeUnverified(up.Token)!;
        Assert.Equal("LIFETIME", claims.Type); Assert.Null(claims.Expires); Assert.Equal(old.LicenseId, claims.Renews);
        Assert.Throws<InvalidOperationException>(() => issuer.Renew(up, T0.AddYears(1)));
    }

    [Fact]
    public void Register_shows_expired_for_limited_licenses_past_their_date()
    {
        var past = new IssuedLicense { LicenseId = "x", Type = "LIMITED", ExpiresAt = DateTimeOffset.UtcNow.AddDays(-2) };
        var soon = new IssuedLicense { LicenseId = "y", Type = "LIMITED", ExpiresAt = DateTimeOffset.UtcNow.AddDays(10) };
        Assert.Equal("Expired", past.StatusDisplay); Assert.Equal("Issued", soon.StatusDisplay); Assert.InRange(soon.DaysLeft!.Value, 9, 11);
    }

    /// <summary>Writes a token signed by THIS code for the Worker's cross-language verification test (run with SM_FIXTURE_OUT set).</summary>
    [Fact]
    public void Emit_fixture_for_worker_compat_test()
    {
        var path = Environment.GetEnvironmentVariable("SM_FIXTURE_OUT"); if (path is null) return;
        var keys = NewKeys(); var issuer = new LicenseIssuer(keys, new IssuedRegister(_root, "development"));
        var rec = issuer.Issue("Interop Client", "tnt_interop", "interop-client", new[] { "video-funnel", "coexistence" });
        // Limited license + its renewal for a second tenant. Expiry is ~10 years out so the committed fixture stays valid for years.
        var ltd = issuer.Issue("Interop Limited", "tnt_interop_ltd", "interop-limited", new[] { "video-funnel" }, type: "LIMITED", expiresAt: DateTimeOffset.UtcNow.AddYears(10));
        var renewal = issuer.Renew(ltd, DateTimeOffset.UtcNow.AddYears(12));
        File.WriteAllText(path, JsonSerializer.Serialize(new { note = "DEVELOPMENT/TEST key generated by the C# License Generator tests. Not a production key.",
            publicPem = keys.PublicKeyPem(), token = rec.Token, tenantId = rec.TenantId, tenantSlug = rec.TenantSlug, licenseId = rec.LicenseId,
            limited = new { token = ltd.Token, tenantId = ltd.TenantId, tenantSlug = ltd.TenantSlug, licenseId = ltd.LicenseId },
            renewal = new { token = renewal.Token, licenseId = renewal.LicenseId, renews = ltd.LicenseId } }, new JsonSerializerOptions { WriteIndented = true }));
    }
}
