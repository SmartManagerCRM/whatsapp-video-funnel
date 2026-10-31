using System.Text.Json.Serialization;

namespace SmartManager.Licensing;

/// <summary>
/// Claims inside a license token. Property names are the wire format read by the Cloudflare Worker
/// (worker/src/licensing/index.ts) - do not rename them.
/// </summary>
public sealed class LicensePayload
{
    public const string ProductId = "smartmanager-whatsapp-video-funnel";
    public const string ProductName = "SmartManager WhatsApp Video Funnel";
    public const string Lifetime = "LIFETIME";
    public const string Limited = "LIMITED";

    [JsonPropertyName("lid")] public string LicenseId { get; set; } = "";
    [JsonPropertyName("pid")] public string ProductIdValue { get; set; } = ProductId;
    [JsonPropertyName("product_name")] public string ProductNameValue { get; set; } = ProductName;
    [JsonPropertyName("client_name")] public string ClientName { get; set; } = "";
    [JsonPropertyName("tenant_id")] public string TenantId { get; set; } = "";
    [JsonPropertyName("tenant_slug")] public string TenantSlug { get; set; } = "";
    /// <summary>Issue time, Unix seconds.</summary>
    [JsonPropertyName("iat")] public long IssuedAt { get; set; }
    [JsonPropertyName("type")] public string Type { get; set; } = Lifetime;
    /// <summary>Never set for LIFETIME licenses (they have no expiration date). Required for LIMITED licenses.</summary>
    [JsonPropertyName("exp"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public long? Expires { get; set; }
    [JsonPropertyName("features")] public List<string> Features { get; set; } = new();
    [JsonPropertyName("max_numbers")] public int MaxNumbers { get; set; } = 1;
    [JsonPropertyName("transfer_from"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? TransferFrom { get; set; }
    /// <summary>License ID of this tenant's LIMITED license that this one extends, or upgrades to LIFETIME.</summary>
    [JsonPropertyName("renews"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Renews { get; set; }
}

/// <summary>One entry of the local issued-license register.</summary>
public sealed class IssuedLicense
{
    public string LicenseId { get; set; } = "";
    public string ClientName { get; set; } = "";
    public string TenantId { get; set; } = "";
    public string TenantSlug { get; set; } = "";
    public string Type { get; set; } = LicensePayload.Lifetime;
    public List<string> Features { get; set; } = new();
    public int MaxNumbers { get; set; } = 1;
    public DateTimeOffset IssuedAt { get; set; }
    public string KeyFingerprint { get; set; } = "";
    public string KeyProfile { get; set; } = "";
    public string? TransferFrom { get; set; }
    public string? Renews { get; set; }
    /// <summary>Null for LIFETIME licenses.</summary>
    public DateTimeOffset? ExpiresAt { get; set; }
    /// <summary>Local bookkeeping only. Revocation takes effect when the platform owner revokes it in the owner portal.</summary>
    public string Status { get; set; } = "Issued";
    public string Token { get; set; } = "";
    public string? Notes { get; set; }

    /// <summary>What the register shows: a LIMITED license past its date reads "Expired" regardless of the stored status.</summary>
    [JsonIgnore] public string StatusDisplay => Status == "Issued" && ExpiresAt is { } e && e < DateTimeOffset.UtcNow ? "Expired" : Status;
    [JsonIgnore] public string ExpiresDisplay => ExpiresAt is { } e ? e.ToString("yyyy-MM-dd") : "never";
    [JsonIgnore] public int? DaysLeft => ExpiresAt is { } e ? (int)Math.Ceiling((e - DateTimeOffset.UtcNow).TotalDays) : null;
}
