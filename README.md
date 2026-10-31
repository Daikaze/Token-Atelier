# Token Atelier

## v0.2.8 — Native responsive Foundry UI
- Uses Foundry ApplicationV2 native title bar, double-click minimization, and edge resizing.
- Responsive two-panel preview/settings layout with a square canvas that scales with the window.
- Form controls and section panels use Foundry theme colors; no global CSS selectors.
- Art rows can be selected with Enter or Space when focused.
- Existing presets, image alignments, exports, backups and GM permissions are unchanged.


A **GM-only** token maker for Foundry VTT v13 and v14 (built for the dnd5e system, ApplicationV2). This repository targets v13/v14. Align one piece of art and the alignment is remembered, so alternate art of the same character lines up the same way.

## Install directly from GitHub (recommended)
1. In Foundry VTT **Setup > Add-on Modules > Install Module**, paste this URL in the **Manifest URL** field:
   `https://raw.githubusercontent.com/Daikaze/Token-Atelier/main/module.json`
2. Click **Install**, then enable **Token Atelier** in **Manage Modules** in your world.
3. Future versions will be offered through Foundry updates when the repository manifest and ZIP are updated.

## Manual installation
1. Download `dist/token-atelier.zip` from the GitHub repository.
2. Extract it so the folder `token-atelier` sits in `<Foundry Data>/modules/`.
3. Restart Foundry, then enable **Token Atelier** in your world under Manage Modules.

## Permissions (v0.2.2)
- **Only Game Masters** can open Token Atelier, create/edit borders, save alignments, or export tokens.
- Regular players do not see Token Atelier in Actor Sheet header controls or the Actors sidebar context menu, including for characters they own.
- The module API also rejects non-GM users; exporting and saving are GM-restricted.
- Players can still see and use the tokens made by the GM. This does **not** alter Foundry's built-in permissions for editing token images outside the module.

## Use
- Open an actor sheet and click **Token Atelier** in the header controls menu, or right-click an actor in the sidebar and choose **Token Atelier**.
- **Add art** to pick images (or **Use portrait**). Drag to move, scroll to zoom, use the sliders for fine zoom and rotation.
- By default every art uses one **shared alignment**. Line up the first art, then add the second: it appears with the same placement. Adjust once and all linked art follows.
- Untick **Use the shared alignment for this art** to give one image its own placement without affecting the others. **Save as shared alignment** promotes the current placement to the shared one.
- Choose a shape, a ring (color and width) or your own frame image (a PNG with a transparent middle), and a background. With a custom frame, the art is trimmed to the frame's own window, so it never pokes past the border.
- **Save token** exports a PNG into the chosen folder and, optionally, sets it as the actor's token image and/or portrait.

## How alignment carries over
Placement is stored as fractions of the token size (offset, zoom, rotation), not pixels. Images with the same framing line up exactly, whatever their resolution. Images with different framing or aspect ratio land close, and you can nudge them or unlink them.

## Notes
- Images hosted outside Foundry can block export (browser CORS rules). Keep art in your Foundry data folder.
- Exporting needs the file upload permission.
- Tokens already placed on a scene are not changed; only the actor's prototype token is updated.
- Console API: `game.modules.get("token-atelier").api.open(actor)`.

## Fixes in 0.2.1 (Foundry V14)
- Fixed the editor not opening when selecting the Token Atelier header button or actor context menu. The module data field previously collided with ApplicationV2's read-only `state` property.
- Opening now awaits rendering and reports errors in Foundry notifications/console instead of failing silently.
- The header option is named **Token Atelier** to distinguish it from Foundry's native token settings.

## Changes in 0.2.2
- Restricted all Token Atelier entry points to GMs; hid entry points for players.
- Blocked direct module API/editor access for non-GMs and restricted the module's save and export paths.
- Preserved all existing token designs and alignment data.

### Updating from 0.2.0 / 0.2.1
1. Stop Foundry. Replace the old `Data/modules/token-atelier` directory with the folder inside the updated ZIP (do not install a second copy).
2. Restart Foundry and refresh your browser (Ctrl+F5).
3. Right-click an Actor in the Actors sidebar and choose **Token Atelier**, or open an Actor Sheet and choose **Token Atelier** in the header controls.
4. If it still does not open, press F12 > Console and copy the red error message.

Existing actor token placement data is stored in Foundry's actor flags and is preserved.

## Changes in 0.2.3
- Added a GitHub manifest and direct ZIP download URL so Foundry can install/update from the repository.
- GM-only editing and all fixes from 0.2.2 remain unchanged.

## What's new in v0.2.4

- **Border Presets Library (GM-only)**: save a named visual frame/style preset for the entire Foundry world, apply it to another actor, or delete the preset without modifying already customized actors. Presets intentionally do not change art, alignment, image size, export folder or actor update options. Duplicate names are refused.
- **Batch Export**: safely export all registered art variants as separate PNG files, including their linked/unlinked alignments. This does not change the actor's token/portrait or active art. Failures of individual images are reported while other items continue.
- **Safe Save & Backup**: single and batch export check the destination and allocate unique filenames (`name.png`, `name-2.png`, etc.) rather than overwriting. Download the actor's Atelier settings to a JSON backup and restore them later with confirmation and an automatic pre-restore backup download. Restore only replaces this actor's Atelier settings, not token assets or world presets.
- **Compatibility**: retains actor flag schema `data` (version 1), Foundry V14/13 ApplicationV2, GM-only restrictions, and prior v0.2.3 entry points. Existing designs are not migrated or reset.

### Upgrade / safety notes

Back up your world before upgrading. The new global preset setting is empty until you add presets; existing actor designs remain unchanged. Before any export, Foundry must successfully list the destination folder; if the folder cannot be listed, the export stops rather than risk an overwrite. Batch export does not change the actor's token image; use **Save selected token** for that. Browser-based backup download must be permitted by the browser.


## New in v0.2.5 — Bulk Import

- **Import Foundry folder:** In the actor's **Art > Bulk Import**, choose **Import Foundry folder** and select a folder in your **Foundry Data** directory. Every PNG, JPG, JPEG, WebP, GIF, or AVIF image directly inside that folder is added as an art variant. Subfolders and unrelated files are ignored; no images are uploaded or moved.
- **Upload multiple images:** Choose **Upload multiple images** and select several image files from your computer in one go. The module uploads source images into `<export folder>/source-art/<actor-name>-<actor-id>/`, using collision-safe filenames, then adds them to the actor's art list.
- Both options are **GM only**, preserve existing images, the selected art, border presets and shared/individual alignments, and save actor data once per import. A maximum of 250 images per actor matches the existing backup restore limit.
- Bulk Import does **not** replace the actor portrait, token, or any exported PNG. Previously imported Foundry paths are skipped. You can still use **Export all arts** to render the tokens afterward.
- If folder browsing or uploads fail, existing imported art is not removed, and the error is shown in Foundry notifications and the F12 console.

## New in v0.2.6 — Left Toolbar Shortcut

- Added a dedicated **Token Atelier** palette icon to the **left-hand Scene Controls toolbar** in Foundry VTT v14 (also supported in v13). The icon appears for GMs only.
- Clicking the palette icon immediately opens Token Atelier for a currently selected token's Actor. If no editable token is selected, a **Choose Actor** dialog lets the GM pick from world Actors instead.
- An **Open Token Atelier** tool within the palette can reopen the chooser/editor while the palette remains active.
- Existing Actor Sheet and Actors-sidebar entry points remain available. All stored art, presets, backups, and alignments are unchanged.

## New in v0.2.7 — Direct Workspace Opening

- The **Token Atelier palette** in the left Foundry Scene Controls toolbar opens a **standalone Workspace immediately**, without choosing an Actor or selecting a token.
- The Workspace saves art, alignment, and options to the current GM User's `token-atelier.workspaceData` flag, not to any world Actor.
- Add art, bulk import, use presets, backup/restore, and export safe non-overwriting PNGs. Workspace exports never update any Actor's token image or portrait.
- Actor Sheet and Actors sidebar entry points still open a specific Actor's editor. Calling `game.modules.get("token-atelier").api.open()` opens Workspace; passing an Actor continues to work.
