fn main() {
    // Windows icon resources are compiled here; watch them when only artwork changes.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
