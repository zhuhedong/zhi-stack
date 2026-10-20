//! `/download` page for `WEB_UI=landing`: picks the installer matching the
//! visitor's OS from request headers (no JavaScript, so [`crate::WEB_CSP`]
//! holds) and links to version-less release assets that GitHub always
//! resolves to the latest release.

use axum::http::HeaderMap;

pub const DEFAULT_BASE: &str = "https://github.com/zhuhedong/zhi-stack/releases/latest/download";
pub const RELEASES_PAGE: &str = "https://github.com/zhuhedong/zhi-stack/releases/latest";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
    Mobile,
    Unknown,
}

impl Os {
    pub fn from_query(q: &str) -> Option<Os> {
        match q.to_ascii_lowercase().as_str() {
            "mac" | "macos" => Some(Os::Mac),
            "win" | "windows" => Some(Os::Windows),
            "linux" => Some(Os::Linux),
            _ => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Os::Mac => "macOS",
            Os::Windows => "Windows",
            Os::Linux => "Linux",
            Os::Mobile => "手机",
            Os::Unknown => "未知系统",
        }
    }
}

/// Detects the OS, preferring the `Sec-CH-UA-Platform` client hint.
pub fn detect(headers: &HeaderMap) -> Os {
    let get = |n: &str| {
        headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    if get("sec-ch-ua-mobile") == "?1" {
        return Os::Mobile;
    }
    match get("sec-ch-ua-platform").trim_matches('"') {
        "macos" => return Os::Mac,
        "windows" => return Os::Windows,
        "linux" | "chrome os" => return Os::Linux,
        "android" | "ios" | "ipados" => return Os::Mobile,
        _ => {}
    }
    detect_ua(&get("user-agent"))
}

pub fn detect_ua(ua: &str) -> Os {
    let ua = ua.to_ascii_lowercase();
    // Phones/tablets first. Classic iPad UAs contain "ipad"; iPhone contains
    // "iphone" (and also "like mac os x", so order matters). iPadOS desktop
    // mode sends a Macintosh Safari UA with no iPad token — that case is
    // indistinguishable from a real Mac without client hints, so we fall
    // through to Mac only when no mobile signal is present.
    if [
        "iphone",
        "ipad",
        "ipod",
        "android",
        "mobile",
        "windows phone",
        "opera mini",
    ]
    .iter()
    .any(|k| ua.contains(k))
    {
        Os::Mobile
    } else if ua.contains("windows") {
        Os::Windows
    } else if ua.contains("mac os x") || ua.contains("macintosh") {
        Os::Mac
    } else if ua.contains("linux") || ua.contains("x11") || ua.contains("cros") {
        Os::Linux
    } else {
        Os::Unknown
    }
}

struct Asset {
    os: Os,
    file: &'static str,
    title: &'static str,
    note: &'static str,
}

const ASSETS: &[Asset] = &[
    Asset {
        os: Os::Mac,
        file: "InfoHub_macos_aarch64.dmg",
        title: "macOS · Apple 芯片",
        note: "M1 / M2 / M3 / M4，.dmg",
    },
    Asset {
        os: Os::Mac,
        file: "InfoHub_macos_x64.dmg",
        title: "macOS · Intel 芯片",
        note: "2020 年及更早的 Intel Mac，.dmg",
    },
    Asset {
        os: Os::Windows,
        file: "InfoHub_windows_x64-setup.exe",
        title: "Windows · 安装程序",
        note: "Windows 10 / 11 64 位，.exe（推荐）",
    },
    Asset {
        os: Os::Windows,
        file: "InfoHub_windows_x64.msi",
        title: "Windows · MSI",
        note: "适合企业批量部署，.msi",
    },
    Asset {
        os: Os::Linux,
        file: "InfoHub_linux_amd64.AppImage",
        title: "Linux · AppImage",
        note: "x86_64 通用，赋予执行权限即可运行",
    },
    Asset {
        os: Os::Linux,
        file: "InfoHub_linux_amd64.deb",
        title: "Linux · Debian / Ubuntu",
        note: "x86_64，.deb",
    },
];

fn esc(v: &str) -> String {
    crate::html_escape(v)
}

pub fn page(os: Os, base: &str) -> String {
    let base = base.trim_end_matches('/');
    let url = |a: &Asset| esc(&format!("{base}/{}", a.file));
    let version = env!("CARGO_PKG_VERSION");
    let primary = ASSETS.iter().find(|a| a.os == os);
    let hero = match primary {
        Some(a) => {
            let extra = if os == Os::Mac {
                r#"<p class="hint">默认提供 Apple 芯片版本；Intel Mac 请在下方选择 Intel 版本。</p>"#
            } else {
                ""
            };
            format!(
                r#"<p class="detect">检测到你正在使用 <b>{}</b></p><a class="btn big" href="{}" rel="noopener noreferrer">下载 {} <small>v{version}</small></a>{extra}"#,
                os.label(),
                url(a),
                a.title
            )
        }
        None if os == Os::Mobile => r#"<p class="detect">检测到你正在使用 <b>手机</b></p><p class="hint">桌面客户端仅支持 macOS / Windows / Linux，请在电脑上打开本页下载。</p>"#.to_string(),
        None => r#"<p class="detect">未能识别你的系统，请在下方选择对应的安装包。</p>"#.to_string(),
    };
    let mut rows = String::new();
    for a in ASSETS {
        let cls = if a.os == os {
            "row glass on"
        } else {
            "row glass"
        };
        rows.push_str(&format!(
            r#"<a class="{cls}" href="{}" rel="noopener noreferrer"><span><b>{}</b><em>{}</em></span><i>下载</i></a>"#,
            url(a),
            a.title,
            a.note
        ));
    }
    TEMPLATE
        .replace("{{HERO}}", &hero)
        .replace("{{ROWS}}", &rows)
        .replace("{{VERSION}}", version)
        .replace("{{RELEASES}}", RELEASES_PAGE)
}

const TEMPLATE: &str = include_str!("download.html");

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const WIN: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    const LINUX: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
    const IPHONE: &str =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    const IPAD: &str =
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const ANDROID: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";

    #[test]
    fn user_agent_detection() {
        assert_eq!(detect_ua(MAC), Os::Mac);
        assert_eq!(detect_ua(WIN), Os::Windows);
        assert_eq!(detect_ua(LINUX), Os::Linux);
        assert_eq!(detect_ua(IPHONE), Os::Mobile);
        assert_eq!(detect_ua(IPAD), Os::Mobile);
        assert_eq!(detect_ua(ANDROID), Os::Mobile);
        assert_eq!(detect_ua("curl/8.0"), Os::Unknown);
    }

    #[test]
    fn client_hint_ipados_is_mobile() {
        let mut h = HeaderMap::new();
        h.insert("user-agent", MAC.parse().unwrap());
        h.insert("sec-ch-ua-platform", "\"iPadOS\"".parse().unwrap());
        assert_eq!(detect(&h), Os::Mobile);
    }

    #[test]
    fn client_hint_wins_over_user_agent() {
        let mut h = HeaderMap::new();
        h.insert("user-agent", WIN.parse().unwrap());
        h.insert("sec-ch-ua-platform", "\"macOS\"".parse().unwrap());
        assert_eq!(detect(&h), Os::Mac);
        h.insert("sec-ch-ua-mobile", "?1".parse().unwrap());
        assert_eq!(detect(&h), Os::Mobile);
    }

    #[test]
    fn page_points_primary_button_at_detected_os() {
        let p = page(Os::Windows, DEFAULT_BASE);
        assert!(p.contains(&format!(
            r#"class="btn big" href="{DEFAULT_BASE}/InfoHub_windows_x64-setup.exe""#
        )));
        let p = page(Os::Mac, "https://mirror.example/x/");
        assert!(p.contains(
            r#"class="btn big" href="https://mirror.example/x/InfoHub_macos_aarch64.dmg""#
        ));
        assert!(p.contains("InfoHub_macos_x64.dmg"));
        for p in [
            page(Os::Unknown, DEFAULT_BASE),
            page(Os::Mobile, DEFAULT_BASE),
        ] {
            assert!(!p.contains("btn big"));
            assert_eq!(p.matches("class=\"row glass").count(), 6);
        }
        assert!(p.contains(&format!("v{}", env!("CARGO_PKG_VERSION"))));
        assert!(!p.contains("{{") && !p.contains("<script"));
        assert!(p.contains("湘ICP备2023031880号-1"));
    }
}
