// İşlemsel e-posta şablonları (HTML + düz metin).
// E-posta istemcileri için: tablo tabanlı yerleşim, satır içi stiller, harici görsel/yazı tipi yok
// (görseller çoğu istemcide varsayılan olarak engellenir; logo metin + renkle çizilir).
// Marka renkleri arayüzle aynı: birincil #1d4ed8, metin #0f172a, ikincil metin #64748b, zemin #f4f6fa.

const BRAND = {
  primary: '#1d4ed8',
  text: '#0f172a',
  muted: '#64748b',
  bg: '#f4f6fa',
  surface: '#ffffff',
  border: '#e2e8f0',
  font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

/** HTML'e güvenle yerleştirmek için kaçış (kullanıcı adı gibi kullanıcı girdileri). */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Ortak yerleşim.
 * @param {{ appName: string, preheader: string, heading: string, paragraphs: string[], button?: { label: string, url: string },
 *           afterButton?: string[], footer: string }} p   paragraphs/afterButton/footer: önceden kaçışı yapılmış HTML
 */
function layout({ appName, preheader, heading, paragraphs, button, afterButton = [], footer }) {
  const name = escapeHtml(appName);
  const p = (html, extra = '') =>
    `<p style="margin:0 0 16px;font-family:${BRAND.font};font-size:15px;line-height:24px;color:${BRAND.text};${extra}">${html}</p>`;
  const buttonHtml = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
        <tr><td align="center" bgcolor="${BRAND.primary}" style="border-radius:8px;">
          <a href="${escapeHtml(button.url)}" target="_blank"
             style="display:inline-block;padding:13px 26px;font-family:${BRAND.font};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a>
        </td></tr>
      </table>`
    : '';

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
      <tr><td style="padding:0 4px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="36" height="36" align="center" valign="middle" bgcolor="${BRAND.primary}"
              style="width:36px;height:36px;border-radius:9px;font-family:${BRAND.font};font-size:16px;line-height:36px;color:#ffffff;">&#9650;</td>
          <td style="padding-left:12px;font-family:${BRAND.font};font-size:18px;font-weight:700;color:${BRAND.text};">${name}</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:12px;padding:32px 32px 16px;">
        <h1 style="margin:0 0 16px;font-family:${BRAND.font};font-size:22px;line-height:30px;font-weight:700;color:${BRAND.text};">${escapeHtml(heading)}</h1>
        ${paragraphs.map((x) => p(x)).join('\n        ')}
        ${buttonHtml}
        ${afterButton.map((x) => p(x, `font-size:13px;line-height:20px;color:${BRAND.muted};`)).join('\n        ')}
      </td></tr>
      <tr><td style="padding:20px 8px 0;font-family:${BRAND.font};font-size:12px;line-height:18px;color:${BRAND.muted};text-align:center;">
        ${footer}<br>&copy; ${new Date().getFullYear()} ${name}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

const hoursText = (h) => (h % 24 === 0 ? `${h / 24 === 1 ? '24 saat' : `${h / 24} gün`}` : `${h} saat`);

/** E-posta doğrulama. */
export function verificationEmail({ appName, username, email, url, expiresInHours }) {
  const subject = `${appName} hesabınızı doğrulayın`;
  const validity = hoursText(expiresInHours);
  const html = layout({
    appName,
    preheader: `E-posta adresinizi doğrulayın — bağlantı ${validity} geçerli.`,
    heading: 'E-posta adresinizi doğrulayın',
    paragraphs: [
      `Merhaba ${escapeHtml(username)},`,
      `${escapeHtml(appName)} hesabınızı oluşturduğunuz için teşekkürler. Hesabınızı etkinleştirmek için aşağıdaki butona tıklayarak e-posta adresinizi doğrulayın.`,
    ],
    button: { label: 'E-posta adresimi doğrula', url },
    afterButton: [
      `Bu bağlantı <strong>${validity}</strong> geçerlidir ve yalnızca bir kez kullanılabilir.`,
      `Buton çalışmazsa bu adresi tarayıcınıza yapıştırın:<br><a href="${escapeHtml(url)}" style="color:${BRAND.primary};word-break:break-all;">${escapeHtml(url)}</a>`,
    ],
    footer: `Bu e-postayı ${escapeHtml(email)} adresiyle bir ${escapeHtml(appName)} hesabı oluşturulduğu için aldınız. Hesabı siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.`,
  });
  const text = [
    `Merhaba ${username},`,
    '',
    `${appName} hesabınızı etkinleştirmek için e-posta adresinizi doğrulayın:`,
    url,
    '',
    `Bu bağlantı ${validity} geçerlidir ve yalnızca bir kez kullanılabilir.`,
    '',
    `Hesabı siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.`,
    `— ${appName}`,
  ].join('\n');
  return { subject, html, text };
}

/** Şifre sıfırlama. */
export function passwordResetEmail({ appName, username, email, url, expiresInMinutes }) {
  const subject = `${appName} şifre sıfırlama`;
  const html = layout({
    appName,
    preheader: `Şifrenizi sıfırlamak için bağlantı — ${expiresInMinutes} dakika geçerli.`,
    heading: 'Şifrenizi sıfırlayın',
    paragraphs: [`Merhaba ${escapeHtml(username)},`, 'Hesabınız için bir şifre sıfırlama isteği aldık. Yeni şifre belirlemek için aşağıdaki butona tıklayın.'],
    button: { label: 'Yeni şifre belirle', url },
    afterButton: [
      `Bu bağlantı <strong>${expiresInMinutes} dakika</strong> geçerlidir ve yalnızca bir kez kullanılabilir. Şifreniz değiştiğinde diğer cihazlardaki oturumlarınız kapatılır.`,
      `Buton çalışmazsa bu adresi tarayıcınıza yapıştırın:<br><a href="${escapeHtml(url)}" style="color:${BRAND.primary};word-break:break-all;">${escapeHtml(url)}</a>`,
    ],
    footer: `Bu e-posta ${escapeHtml(email)} adresine, şifre sıfırlama istendiği için gönderildi. İsteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz; şifreniz değişmez.`,
  });
  const text = [
    `Merhaba ${username},`,
    '',
    'Şifrenizi sıfırlamak için bu bağlantıyı açın:',
    url,
    '',
    `Bağlantı ${expiresInMinutes} dakika geçerlidir ve yalnızca bir kez kullanılabilir.`,
    'İsteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz; şifreniz değişmez.',
    `— ${appName}`,
  ].join('\n');
  return { subject, html, text };
}

/** Kullanıcının yazdığı düz metin e-posta (teklif e-postası) için sade HTML karşılığı. */
export function plainTextToHtml(text) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#ffffff;">
<div style="font-family:${BRAND.font};font-size:15px;line-height:24px;color:${BRAND.text};white-space:pre-wrap;">${escapeHtml(text)}</div>
</body></html>`;
}
