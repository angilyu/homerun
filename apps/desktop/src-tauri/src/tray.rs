//! The menu-bar item (§5.1). `shell-core::tray::build` decides what it shows; this turns that
//! into Tauri's tray and menu, and hands clicks back as `Action`s.

use homerun_shell_core::tray::{Entry, Icon, Menu};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu as TMenu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Wry};

const ID: &str = "homerun";

fn icon(i: Icon) -> Image<'static> {
    match i {
        Icon::Normal => tauri::include_image!("icons/tray-normal.png"),
        Icon::Attention => tauri::include_image!("icons/tray-attention.png"),
        Icon::Trouble => tauri::include_image!("icons/tray-trouble.png"),
    }
}

/// What is on screen now, so an unchanged menu isn't rebuilt under the user's pointer.
static SHOWN: Mutex<Option<Menu>> = Mutex::new(None);

/// Menu clicks arrive through the app-wide `on_menu_event` (main.rs), which covers this menu and
/// the fallback app menu alike.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID).icon(icon(Icon::Normal)).icon_as_template(true).tooltip("Homerun").show_menu_on_left_click(true).build(app)?;
    Ok(())
}

fn items(app: &AppHandle, entries: &[Entry]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = vec![];
    for e in entries {
        out.push(match e {
            Entry::Item { label, action: Some(a) } => Box::new(MenuItem::with_id(app, a.id(), label, true, None::<&str>)?),
            Entry::Item { label, action: None } => Box::new(MenuItem::new(app, label, false, None::<&str>)?),
            Entry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            Entry::Submenu { label, items: sub } => {
                let sub = items(app, sub)?;
                let refs: Vec<&dyn IsMenuItem<Wry>> = sub.iter().map(|b| &**b).collect();
                Box::new(Submenu::with_items(app, label, true, &refs)?)
            }
        });
    }
    Ok(out)
}

pub fn render(app: &AppHandle, m: &Menu) -> tauri::Result<()> {
    let mut shown = SHOWN.lock().unwrap();
    if shown.as_ref() == Some(m) {
        return Ok(());
    }
    let Some(tray) = app.tray_by_id(ID) else { return Ok(()) };
    let built = items(app, &m.entries)?;
    let refs: Vec<&dyn IsMenuItem<Wry>> = built.iter().map(|b| &**b).collect();
    tray.set_menu(Some(TMenu::with_items(app, &refs)?))?;
    if shown.as_ref().map(|s| s.icon) != Some(m.icon) {
        tray.set_icon(Some(icon(m.icon)))?;
        tray.set_icon_as_template(true)?;
    }
    tray.set_title(m.badge.as_deref())?;
    tray.set_tooltip(Some(&m.tooltip))?;
    *shown = Some(m.clone());
    Ok(())
}
