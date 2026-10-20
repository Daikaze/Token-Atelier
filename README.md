# Token Atelier

A **GM-only** token maker for Foundry VTT v13 and v14 (built for the dnd5e system, ApplicationV2). A v11 build is provided separately. Align one piece of art and the alignment is remembered, so alternate art of the same character lines up the same way.

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