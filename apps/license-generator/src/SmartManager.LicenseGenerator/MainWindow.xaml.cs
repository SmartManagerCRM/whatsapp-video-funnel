using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;
using SmartManager.Licensing;

namespace SmartManager.LicenseGenerator;

public partial class MainWindow : Window
{
    private readonly string _root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SmartManager", "LicenseGenerator");
    private readonly IKeyProtector _protector = new DpapiKeyProtector();
    private KeyStore _keys = null!; private IssuedRegister _register = null!; private LicenseIssuer _issuer = null!;
    private string _profile = "development";
    private IssuedLicense? _selected; private IssuedLicense? _lastGenerated;
    private bool _loading = true;

    public MainWindow()
    {
        InitializeComponent();
        Directory.CreateDirectory(_root);
        var sp = Path.Combine(_root, "settings.json");
        if (File.Exists(sp)) try { _profile = JsonDocument.Parse(File.ReadAllText(sp)).RootElement.GetProperty("profile").GetString() ?? "development"; } catch { }
        ProfileBox.SelectedIndex = _profile == "production" ? 1 : 0;
        DataDir.Text = _root;
        LoadProfile(); _loading = false;
    }

    private void LoadProfile()
    {
        _keys = new KeyStore(_root, _profile, _protector); _register = new IssuedRegister(_root, _profile); _issuer = new LicenseIssuer(_keys, _register);
        File.WriteAllText(Path.Combine(_root, "settings.json"), JsonSerializer.Serialize(new { profile = _profile }));
        RefreshAll();
    }

    private void RefreshAll()
    {
        var prod = _profile == "production";
        ProfileBanner.Background = new SolidColorBrush(prod ? Color.FromRgb(0x0F, 0x76, 0x6E) : Color.FromRgb(0xB4, 0x53, 0x09));
        BannerText.Text = prod ? "PRODUCTION signing key profile" : "DEVELOPMENT signing key profile - licenses are for testing only";
        BannerKey.Text = _keys.HasKey ? $"key {_keys.Fingerprint()[..16]}…" : "no key";
        var all = _register.All();
        Grid.ItemsSource = all.OrderByDescending(x => x.IssuedAt).ToList();
        StatIssued.Text = all.Count.ToString(); StatTransferred.Text = all.Count(x => x.Status == "Transferred").ToString();
        StatKey.Text = _keys.HasKey ? _keys.Fingerprint()[..16] + "…" : "none";
        DashHint.Text = _keys.HasKey ? "" : "No signing key for this profile yet. Open 'Key Management' and generate one before issuing licenses.";
        KeyInfo.Text = _keys.HasKey
            ? $"Profile: {_profile}\nFingerprint (SHA-256 of public key): {_keys.Fingerprint()}\nThe private key is protected with Windows DPAPI for this Windows user and is stored only on this PC."
            : $"Profile: {_profile}\nNo key yet. Generate one, then immediately create an encrypted backup.";
    }

    private static string Msg(Exception e) => e.Message;
    private void Warn(string text) => MessageBox.Show(this, text, "SmartManager License Generator", MessageBoxButton.OK, MessageBoxImage.Warning);
    private void Info(string text) => MessageBox.Show(this, text, "SmartManager License Generator", MessageBoxButton.OK, MessageBoxImage.Information);

    // ------------------------------------------------------------ generate
    private void Generate_Click(object s, RoutedEventArgs e)
    {
        try
        {
            if (!int.TryParse(GenNumbers.Text, out var n) || n < 1) throw new ArgumentException("Authorized WhatsApp numbers must be 1 or more");
            var features = new List<string> { "video-funnel" }; if (FeatCoexist.IsChecked == true) features.Add("coexistence");
            if (_profile == "production" && MessageBox.Show(this, $"Issue a PRODUCTION lifetime license for '{GenClient.Text.Trim()}' (tenant {GenSlug.Text.Trim()})?", "Confirm", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            _lastGenerated = _issuer.Issue(GenClient.Text, GenTenantId.Text, GenSlug.Text, features, n);
            GenResult.Text = $"Issued {_lastGenerated.LicenseId} (LIFETIME, no expiry). Save the .smlic file and send it to the client.";
            GenToken.Text = _lastGenerated.Token; GenToken.Visibility = Visibility.Visible; GenActions.Visibility = Visibility.Visible;
            RefreshAll();
        }
        catch (Exception ex) { Warn(Msg(ex)); }
    }
    private void GenSave_Click(object s, RoutedEventArgs e) { if (_lastGenerated != null) SaveSmlic(_lastGenerated); }
    private void GenCopy_Click(object s, RoutedEventArgs e) { if (_lastGenerated != null) Clipboard.SetText(_lastGenerated.Token); }

    private void SaveSmlic(IssuedLicense l)
    {
        var dlg = new SaveFileDialog { Filter = "SmartManager license (*.smlic)|*.smlic", FileName = $"{l.TenantSlug}.smlic" };
        if (dlg.ShowDialog(this) == true) { File.WriteAllText(dlg.FileName, LicenseSigner.ToSmlic(l.Token)); Info($"Saved {dlg.FileName}"); }
    }

    // ------------------------------------------------------------ selection / details
    private void Grid_SelectionChanged(object s, SelectionChangedEventArgs e)
    {
        _selected = Grid.SelectedItem as IssuedLicense;
        ExportInfo.Text = _selected is null ? "Select a license in 'Issued Licenses' first." : $"{_selected.LicenseId} - {_selected.ClientName} ({_selected.TenantSlug})";
        XferInfo.Text = _selected is null ? "Select the license to transfer in 'Issued Licenses' first." : $"Transfer {_selected.LicenseId} from {_selected.ClientName} ({_selected.TenantSlug}).";
    }
    private void Tabs_SelectionChanged(object s, SelectionChangedEventArgs e)
    {
        if (_loading || e.OriginalSource != Tabs) return;
        if (Tabs.SelectedIndex == 3) ShowDetails();
    }
    private void ShowDetails()
    {
        if (_selected is null) { DetailStatus.Text = "Select a license in 'Issued Licenses' first."; DetailText.Text = ""; return; }
        var decoded = LicenseSigner.DecodeUnverified(_selected.Token);
        var valid = false;
        if (_keys.HasKey) { using var pub = _keys.LoadPublic(); valid = LicenseSigner.TryVerify(_selected.Token, pub, out _); }
        DetailStatus.Text = valid ? "✔ Signature valid for the current key profile" : "✖ Signature does NOT verify with the current profile's key (different key or profile?)";
        DetailStatus.Foreground = valid ? Brushes.DarkGreen : Brushes.DarkRed;
        DetailText.Text = JsonSerializer.Serialize(new { register = new { _selected.Status, _selected.KeyProfile, _selected.KeyFingerprint, _selected.Notes }, claims = decoded }, new JsonSerializerOptions { WriteIndented = true });
    }

    // ------------------------------------------------------------ export / transfer
    private void ExportSave_Click(object s, RoutedEventArgs e) { if (_selected is null) Warn("Select a license first."); else SaveSmlic(_selected); }
    private void ExportCopy_Click(object s, RoutedEventArgs e) { if (_selected is null) Warn("Select a license first."); else Clipboard.SetText(_selected.Token); }

    private void Transfer_Click(object s, RoutedEventArgs e)
    {
        try
        {
            if (_selected is null) throw new InvalidOperationException("Select the license to transfer first.");
            if (MessageBox.Show(this, $"Issue a replacement license for '{XferSlug.Text.Trim()}' that transfers {_selected.LicenseId}?\n\nYou must also approve the transfer in the Owner portal.", "Confirm transfer", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            var moved = _issuer.Issue(XferClient.Text, XferTenantId.Text, XferSlug.Text, _selected.Features, _selected.MaxNumbers, transferFrom: _selected.LicenseId);
            _register.SetStatus(_selected.LicenseId, "Transferred", $"Transferred to {moved.TenantSlug} ({moved.LicenseId})");
            XferResult.Text = $"Issued {moved.LicenseId}. Now approve the transfer in the Owner portal, then send the new .smlic to the client.";
            _lastGenerated = moved; SaveSmlic(moved); RefreshAll();
        }
        catch (Exception ex) { Warn(Msg(ex)); }
    }

    // ------------------------------------------------------------ keys
    private void KeyGen_Click(object s, RoutedEventArgs e)
    {
        try
        {
            if (_keys.HasKey) { Warn("A key already exists for this profile. Export a backup, then delete the folder under Settings → Data folder → keys\\" + _profile + " if you truly intend to replace it (this invalidates every license signed by the old key once the Worker public key is changed)."); return; }
            var warn = _profile == "production" ? "Generate the PRODUCTION signing key?\n\nBack it up immediately afterwards - it cannot be recovered." : "Generate a DEVELOPMENT signing key?";
            if (MessageBox.Show(this, warn, "Confirm", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            _keys.Generate(3072); RefreshAll();
            Info("Key generated. Next: (1) export an encrypted backup, (2) set the public key as the Worker secret LICENSE_PUBLIC_KEY.");
        }
        catch (Exception ex) { Warn(Msg(ex)); }
    }
    private void KeyCopyPub_Click(object s, RoutedEventArgs e) { if (_keys.HasKey) Clipboard.SetText(_keys.PublicKeyPem()); else Warn("No key yet."); }
    private void KeySavePub_Click(object s, RoutedEventArgs e)
    {
        if (!_keys.HasKey) { Warn("No key yet."); return; }
        var dlg = new SaveFileDialog { Filter = "PEM (*.pem)|*.pem", FileName = $"smartmanager-license-public-{_profile}.pem" };
        if (dlg.ShowDialog(this) == true) File.WriteAllText(dlg.FileName, _keys.PublicKeyPem());
    }
    private void KeyBackup_Click(object s, RoutedEventArgs e)
    {
        try
        {
            if (!_keys.HasKey) { Warn("No key yet."); return; }
            var pass = Prompt("Backup passphrase (12+ characters). You will need it to restore."); if (pass is null) return;
            var again = Prompt("Repeat the passphrase"); if (again != pass) { Warn("Passphrases do not match."); return; }
            var dlg = new SaveFileDialog { Filter = "SmartManager key backup (*.smkey)|*.smkey", FileName = $"smartmanager-{_profile}-key-backup.smkey" };
            if (dlg.ShowDialog(this) == true) { File.WriteAllText(dlg.FileName, _keys.ExportBackup(pass)); Info("Encrypted backup saved. Store it offline in two places; keep the passphrase separately."); }
        }
        catch (Exception ex) { Warn(Msg(ex)); }
    }
    private void KeyRestore_Click(object s, RoutedEventArgs e)
    {
        try
        {
            var dlg = new OpenFileDialog { Filter = "SmartManager key backup (*.smkey)|*.smkey" }; if (dlg.ShowDialog(this) != true) return;
            var pass = Prompt("Backup passphrase"); if (pass is null) return;
            _keys.ImportBackup(File.ReadAllText(dlg.FileName), pass); RefreshAll(); Info("Key restored.");
        }
        catch (Exception ex) { Warn(Msg(ex)); }
    }

    // ------------------------------------------------------------ settings
    private void Profile_Changed(object s, SelectionChangedEventArgs e)
    {
        if (_loading) return;
        _profile = ((ComboBoxItem)ProfileBox.SelectedItem).Content.ToString()!; LoadProfile();
    }
    private void OpenDir_Click(object s, RoutedEventArgs e) => Process.Start(new ProcessStartInfo("explorer.exe", _root) { UseShellExecute = true });

    /// <summary>Minimal passphrase prompt (masked input).</summary>
    private string? Prompt(string title)
    {
        var box = new PasswordBox { Margin = new Thickness(0, 8, 0, 12), Padding = new Thickness(6) };
        var ok = new Button { Content = "OK", IsDefault = true, Width = 80 }; var cancel = new Button { Content = "Cancel", IsCancel = true, Width = 80, Style = (Style)FindResource("Secondary") };
        var panel = new StackPanel { Margin = new Thickness(16) };
        panel.Children.Add(new TextBlock { Text = title, TextWrapping = TextWrapping.Wrap }); panel.Children.Add(box);
        panel.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Children = { ok, cancel } });
        var win = new Window { Title = "SmartManager License Generator", Content = panel, Width = 420, SizeToContent = SizeToContent.Height, Owner = this, WindowStartupLocation = WindowStartupLocation.CenterOwner, ResizeMode = ResizeMode.NoResize };
        ok.Click += (_, _) => win.DialogResult = true;
        box.Focus();
        return win.ShowDialog() == true ? box.Password : null;
    }
}
