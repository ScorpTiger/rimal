from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Image, Table, TableStyle,
                                PageBreak, KeepTogether, NextPageTemplate, CondPageBreak)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image as PILImage
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
IMG = lambda n: os.path.join(HERE, 'img', n)
VERSION = sys.argv[1] if len(sys.argv) > 1 else 'v4'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'Rimal-User-Manual.pdf')

F = os.environ.get('DEJAVU', '/usr/share/fonts/truetype/dejavu/')
pdfmetrics.registerFont(TTFont('Sans', F + 'DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('Sans-Bold', F + 'DejaVuSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('Sans-It', F + 'DejaVuSans-Oblique.ttf'))
pdfmetrics.registerFont(TTFont('Mono', F + 'DejaVuSansMono.ttf'))
from reportlab.pdfbase.pdfmetrics import registerFontFamily
registerFontFamily('Sans', normal='Sans', bold='Sans-Bold', italic='Sans-It', boldItalic='Sans-Bold')

SAND = colors.HexColor('#E8A33D'); DARK = colors.HexColor('#1F1A14'); INK = colors.HexColor('#2A2520')
MUTED = colors.HexColor('#6E655A'); TINT = colors.HexColor('#FBF4E8'); RED = colors.HexColor('#C0392B'); LINE = colors.HexColor('#E3D6C2')

body = ParagraphStyle('body', fontName='Sans', fontSize=10.5, leading=15, textColor=INK, spaceAfter=6)
small = ParagraphStyle('small', parent=body, fontSize=9, leading=12.5, textColor=MUTED)
h1 = ParagraphStyle('h1', fontName='Sans-Bold', fontSize=20, leading=25, textColor=DARK, spaceBefore=4, spaceAfter=10)
h2 = ParagraphStyle('h2', fontName='Sans-Bold', fontSize=13.5, leading=18, textColor=DARK, spaceBefore=12, spaceAfter=5, keepWithNext=1)
h3 = ParagraphStyle('h3', fontName='Sans-Bold', fontSize=11, leading=15, textColor=colors.HexColor('#8A5A12'), spaceBefore=8, spaceAfter=3, keepWithNext=1)
bullet = ParagraphStyle('bullet', parent=body, leftIndent=14, bulletIndent=3, spaceAfter=3)
step = ParagraphStyle('step', parent=body, leftIndent=18, bulletIndent=0, spaceAfter=3)
cell = ParagraphStyle('cell', parent=body, fontSize=9.5, leading=13, spaceAfter=0)
cellb = ParagraphStyle('cellb', parent=cell, fontName='Sans-Bold')
caption = ParagraphStyle('cap', parent=small, alignment=TA_CENTER, spaceBefore=3, spaceAfter=10, fontName='Sans-It')
code = ParagraphStyle('code', fontName='Mono', fontSize=8.8, leading=12, textColor=DARK, backColor=colors.HexColor('#F1EADF'), borderPadding=6, leftIndent=6, rightIndent=6, spaceBefore=4, spaceAfter=10)

class Doc(BaseDocTemplate):
    def __init__(self, fn):
        super().__init__(fn, pagesize=A4, leftMargin=2.1 * cm, rightMargin=2.1 * cm, topMargin=2 * cm, bottomMargin=2 * cm,
                         title='Rimal Off-Road Navigator — User Manual', author='Rimal', subject='User manual ' + VERSION)
        fr = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id='f')
        self.addPageTemplates([PageTemplate('cover', [fr], onPage=self.cover), PageTemplate('page', [fr], onPage=self.deco)])
    def afterFlowable(self, fl):
        if isinstance(fl, Paragraph) and fl.style.name in ('h1', 'h2'):
            lvl = 0 if fl.style.name == 'h1' else 1
            key = 'k%d' % id(fl)
            self.canv.bookmarkPage(key); self.canv.addOutlineEntry(fl.getPlainText(), key, lvl)
            self.notify('TOCEntry', (lvl, fl.getPlainText(), self.page, key))
    def cover(self, c, d):
        W, H = A4
        c.saveState(); c.setFillColor(DARK); c.rect(0, 0, W, H, fill=1, stroke=0)
        c.drawImage(IMG('cover.jpg'), 0, H * 0.36, W, W * 720 / 1280 * 1.0, preserveAspectRatio=True, anchor='c', mask='auto')
        c.setFillColor(colors.Color(0.12, 0.10, 0.08, alpha=0.55)); c.rect(0, H * 0.36, W, W * 720 / 1280, fill=1, stroke=0)
        c.drawImage(IMG('icon.png'), W / 2 - 2.4 * cm, H * 0.36 + W * 720 / 1280 / 2 - 2.4 * cm, 4.8 * cm, 4.8 * cm, mask='auto')
        c.setFillColor(SAND); c.setFont('Sans-Bold', 40); c.drawCentredString(W / 2, H * 0.27, 'RIMAL')
        c.setFillColor(colors.white); c.setFont('Sans', 16); c.drawCentredString(W / 2, H * 0.27 - 26, 'Off-Road Navigator for Saudi Arabia')
        c.setFont('Sans-Bold', 20); c.drawCentredString(W / 2, H * 0.17, 'User Manual')
        c.setFont('Sans', 11); c.setFillColor(colors.HexColor('#CFC3B0'))
        c.drawCentredString(W / 2, H * 0.17 - 20, f'Version {VERSION} · Android car screens, phones and tablets')
        c.drawCentredString(W / 2, 1.8 * cm, 'Rimal means “sands”: the Rub’ al-Khali, the Nafud and the Red Sands')
        c.restoreState()
    def deco(self, c, d):
        W, H = A4
        c.saveState(); c.setStrokeColor(LINE); c.setLineWidth(0.6)
        c.line(d.leftMargin, H - 1.35 * cm, W - d.rightMargin, H - 1.35 * cm)
        c.setFont('Sans-Bold', 8.5); c.setFillColor(SAND); c.drawString(d.leftMargin, H - 1.2 * cm, 'RIMAL')
        c.setFont('Sans', 8.5); c.setFillColor(MUTED); c.drawRightString(W - d.rightMargin, H - 1.2 * cm, 'User Manual · ' + VERSION)
        c.drawCentredString(W / 2, 1.1 * cm, str(d.page)); c.restoreState()

def P(t, s=body): return Paragraph(t, s)
def B(items, s=bullet): return [Paragraph(t, s, bulletText='•') for t in items]
def S(items): return [Paragraph(t, step, bulletText=f'{i}.') for i, t in enumerate(items, 1)]
def img(path, width_cm, cap=None):
    w, h = PILImage.open(path).size
    out = [Image(path, width=width_cm * cm, height=width_cm * cm * h / w)]
    if cap: out.append(P(cap, caption))
    return KeepTogether(out)
def tbl(rows, widths, head=True):
    data = [[Paragraph(str(c), cellb if (head and i == 0) or j == 0 and not head else cell) for j, c in enumerate(r)] for i, r in enumerate(rows)]
    t = Table(data, colWidths=[w * cm for w in widths], repeatRows=1 if head else 0)
    st = [('VALIGN', (0, 0), (-1, -1), 'TOP'), ('GRID', (0, 0), (-1, -1), 0.4, LINE),
          ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6), ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4)]
    if head: st += [('BACKGROUND', (0, 0), (-1, 0), TINT)]
    t.setStyle(TableStyle(st)); return t
def box(title, text, colour=SAND, bg=TINT):
    t = Table([[Paragraph(f'<b>{title}</b><br/>{text}', ParagraphStyle('bx', parent=body, fontSize=10, leading=14, spaceAfter=0))]], colWidths=[16.8 * cm])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), bg), ('LINEBEFORE', (0, 0), (0, -1), 3, colour),
                           ('LEFTPADDING', (0, 0), (-1, -1), 10), ('RIGHTPADDING', (0, 0), (-1, -1), 10), ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7)]))
    return KeepTogether([t, Spacer(1, 8)])
def side(path, w_img, flow, w_txt=None):
    w, h = PILImage.open(path).size
    im = Image(path, width=w_img * cm, height=w_img * cm * h / w)
    t = Table([[im, flow]], colWidths=[w_img * cm + 0.4 * cm, (w_txt or (16.8 - w_img - 0.4)) * cm])
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
    return t

UI = os.path.join(HERE, 'img', 'ui-'); SH = None
APK = 'https://github.com/ScorpTiger/rimal/releases/download/app-latest/Rimal-OffRoad.apk'
REL = 'https://github.com/ScorpTiger/rimal/releases'
def link(u, t=None): return f'<link href="{u}" color="#8A5A12"><u>{t or u}</u></link>'

st = []
st += [NextPageTemplate('page'), PageBreak()]

# ---------------- contents
toc = TableOfContents()
toc.levelStyles = [ParagraphStyle('t0', fontName='Sans-Bold', fontSize=11, leading=17, leftIndent=0, textColor=DARK),
                   ParagraphStyle('t1', fontName='Sans', fontSize=9.5, leading=13.5, leftIndent=14, textColor=INK)]
st += [P('Contents', ParagraphStyle('ct', parent=h1)), toc, PageBreak()]

# ---------------- 1 welcome
st += [P('1. Welcome to Rimal', h1),
       P('Rimal is an off-road navigator built for desert driving in Saudi Arabia. It shows satellite imagery with roads and tracks on top, records every drive, guides you to coordinates or back along your own tracks, and keeps working with <b>no phone signal at all</b> once its maps are installed.'),
       box('New in version 4', 'Phone layout with five big buttons and a <b>More</b> menu · tap the map to hide the buttons · recording starts only when you tap Record · <b>update the app from inside the app</b> · this manual opens from the app · <b>voice guidance</b> · <b>service checklist</b> · area downloads you can <b>continue</b> after switching the car off · send the activity log through the share menu · ready-made maps are offered only inside Saudi Arabia.'),
       P('This manual covers everything in the current version: installing the app and its maps, the main screen, recording trips, navigating, the safety and trip tools, and what to do when something goes wrong.'),
       P('Where Rimal runs', h2),
       tbl([['Device', 'Notes'],
            ['Android car screen (head unit)', 'The main target. Works on Android 10 and newer with Android System WebView 100+. Turn on <b>Lite mode</b> on slower units (it is on by default).'],
            ['Android phone or tablet', 'Everything works the same. A phone (for example a Galaxy S25 Ultra) has a far better GPS than most car screens — ideal for testing and as a backup.'],
            ['iPad / iPhone', 'Built and starts on iPad; still needs a check on a real iPad and has to be signed with your Apple ID before it can be installed. A Wi-Fi-only iPad has no GPS.']], [4.6, 12.2]),
       Spacer(1, 8),
       P('Do I need internet?', h2),
       P('Only to download the maps the first time and to fetch updates and weather. After that, maps, imagery, terrain, search, trips and navigation all work completely offline. When the unit finds internet again, Rimal quietly checks for newer maps and a fresh forecast.'),
       PageBreak()]

# ---------------- 2 install
st += [P('2. Installing the app', h1),
       P('Download', h2),
       P(f'Latest app: {link(APK, "Rimal-OffRoad.apk")} (about 13 MB). All files, including the maps, are on the Releases page: {link(REL)}.'),
       P('Install on Android', h2)] + S([
       'Open the link on the device (or copy the APK by USB) and tap the downloaded file.',
       'If Android asks, allow <b>Install unknown apps</b> for your browser or file manager, then tap <b>Install</b>.',
       'Open Rimal and allow <b>Location</b> (“While using the app” or “Allow all the time”). On a phone, also set Location accuracy to precise.',
       'The first start can take 20–40 seconds on a car screen while it opens the maps. Later starts are faster.']) + [
       P('Updating the app (from inside the app)', h2),
       P('When the unit is online, Rimal checks for a new version by itself and shows <b>“New Rimal version … is ready”</b> at the top. Tap <b>Update</b> — or any time open <b>Settings &amp; tools → App update</b>. Rimal downloads the new version and opens Android’s installer; trips, waypoints, settings and maps are kept. The first time, Android asks you to allow Rimal to install apps: allow it, go back and tap Update again.'),
       P('You can still install by hand: download the APK (link above) and open it over the old one.'),
       box('One-time step', 'Builds made before the fixed signing key was added (everything up to 24 Nov 2026) were each signed with a different temporary key, so Android refuses to install one over another (“App not installed”). For those, uninstall the old Rimal once, then install the new one. Uninstalling deletes the maps inside the app, so keep your USB map files to import again. From then on, updates install over the top.'),
       P('Permissions Rimal uses', h2)] + B([
       '<b>Location</b> — your position, track recording and navigation. Nothing is sent anywhere.',
       '<b>Storage / files</b> — only when you import maps or GPX files, or save exports to <i>Documents/Rimal</i>.',
       '<b>Motion sensors</b> — the pitch and roll gauges (if the unit has an accelerometer).',
       '<b>Keep screen on</b> — the screen stays awake while Rimal is open.']) + [PageBreak()]

# ---------------- 3 maps
st += [P('3. Offline maps', h1),
       P('Rimal uses map <b>packs</b>: single files that hold one kind of map for the whole country (or a region). Each pack is kept on the device and works with no internet.'),
       P('The packs', h2),
       tbl([['Pack (file)', 'What it gives you', 'Size'],
            ['ksa-map.pmtiles', 'Roads, desert tracks, place names, borders. Vector map — sharp at every zoom.', '956 MB'],
            ['ksa-terrain.pmtiles', 'Elevation: hillshade, contour lines, 3D terrain, ground height.', '240 MB'],
            ['ksa-poi.json', '62,000 places: fuel, water, camps, mechanics, hospitals, police, towns…', '3 MB'],
            ['ksa-satellite.pmtiles', 'Country-wide imagery overview (low zoom).', '62 MB'],
            ['ksa-satellite-nw / ne / sw / se', 'Imagery at zoom 13 (about 17 m per pixel) for each quarter of the Kingdom. NW: Tabuk, Madinah, Hail, Nafud. NE: north Riyadh, Qassim, Eastern Province. SW: Makkah, Asir, Jazan. SE: Red Sands, Empty Quarter.', '640–874 MB each'],
            ['ksa-satellite-alula-…', 'Your own high-detail imagery (zoom 18, about 0.5 m per pixel) made with the laptop tool — see section 3.5.', '~9.5 GB for 50 km']], [4.6, 9.6, 2.6]),
       Spacer(1, 6),
       box('Outside Saudi Arabia', 'The ready-made packs cover Saudi Arabia only, so Rimal does not download them for someone driving elsewhere (for example in India). There the satellite map loads online, and you keep any region offline with <b>Download this area</b> (section 3.4). Trips, navigation and all tools work everywhere.'),
       P('3.1 Installing maps automatically', h2),
       P('With internet, Rimal downloads all packs by itself (about 4.3 GB). Choose when in <b>Maps → Updates &amp; files → Automatic updates</b>: <b>On Wi-Fi</b>, <b>Any connection</b> or <b>Off</b>. A phone hotspot counts as Wi-Fi on most car screens. Tap <b>Check for updates now</b> to start straight away.'),
       P('3.2 Installing maps from a USB stick (no internet needed)', h2)] + S([
       f'On a computer, download the 8 map files from {link(REL, "the Releases page")}. Keep the file names exactly as they are.',
       'Copy them to a USB stick. Files under 4 GB are fine on any stick; for bigger files (like your AlUla pack) format the stick as <b>exFAT</b> (Mac: Disk Utility → Erase → exFAT).',
       'Plug the stick into the car screen (or phone with a USB-C stick).',
       'In Rimal: <b>Maps → Updates &amp; files → Import map files from USB</b> (or <b>Import from USB / more</b> on the “Maps not downloaded yet” card).',
       'Select all the files at once and wait for “Import finished”. You can then remove the stick — the maps are copied into the app.']) + [
       P('Rimal recognises packs installed this way as current and will not download them again; it only downloads real updates later.', small),
       P('3.3 Updates and the backup copy', h2),
       P('New packs are built every month from fresh OpenStreetMap data. When a newer version arrives, Rimal installs it in the background and <b>keeps the previous version</b> as a backup. If the new file is damaged or will not open, Rimal falls back to the previous one automatically. Only the two newest versions of each pack are kept; files you imported by hand are never deleted automatically.'),
       P('3.4 Downloading a small area in more detail', h2),
       P('For places you are about to visit, download sharper imagery for just that area:'),
       ] + S(['Move the map so the area fills the screen.',
              '<b>Maps → Satellite &amp; areas → Download this area for offline</b>.',
              'Choose the detail (max zoom). Rimal shows the number of tiles and the size before you start; stay under about 120,000 tiles per area.',
              'Downloaded areas are listed below the button — <b>View</b> to jump there, <b>Update</b> to refresh, or delete.',
              'If the car is switched off or the connection drops part-way, the area is kept and marked <b>not finished</b>. Tap <b>▶ Continue</b>: tiles already downloaded are skipped and it carries on with the same area — no need to select it again.']) + [
       img(IMG('car-area-continue.jpg'), 11, 'An interrupted area with the Continue button.'),
       P('The default imagery (Sentinel-2) stops at zoom 14 (10 m per pixel). For zoom 15–18, first choose <b>Esri World Imagery</b> under <b>Satellite imagery source</b>. Esri imagery is for personal use; do not share downloaded copies.', small),
       P('3.5 High-detail imagery around home (MacBook tool)', h2),
       P('For a whole circle at zoom 18, use the laptop tool <b>rimal-area-pack.py</b>. It downloads the imagery on your Mac and packs it into one file for USB.'),
       P('cd ~/Downloads<br/>caffeinate -i python3 rimal-area-pack.py --center LAT,LON --radius 50 --maxzoom 18', code),
       tbl([['Radius at zoom 18', 'Tiles', 'File size', 'Download time'], ['25 km', '140,000', '~2.4 GB', '~1 hour'], ['50 km', '560,000', '~9.5 GB', 'a few hours'], ['70 km', '1.1 million', '~19 GB', 'overnight'], ['100 km', '2.2 million', '35–45 GB', 'too large for a car screen']], [4.2, 3.6, 3.6, 5.4]),
       Spacer(1, 6)] + B([
       'If it stops (Wi-Fi drop, lid closed, Ctrl+C), run the same command again — it continues where it stopped.',
       'If the Mac asks to install “command line developer tools”, click Install and run the command again.',
       'The result, <i>ksa-satellite-alula-DATE.pmtiles</i>, is imported like any other pack (section 3.2). Close to home you get zoom 18; further out Rimal uses the country imagery.']) + [
       P('3.6 Storage', h2),
       P('All country packs need about 4.3 GB plus room for one update (another ~1–2 GB while a new version downloads). A 50 km zoom-18 pack adds ~9.5 GB. A 64 GB car screen has room for all of this; check free space in Android Settings → Storage.'),
       PageBreak()]

# ---------------- 4 main screen
st += [P('4. The main screen', h1),
       img(IMG('main-annotated.jpg'), 16.8, 'The main screen on a car screen while recording a trip (Riyadh, real imagery).'),
       tbl([['', 'What it is'],
            ['1', '<b>GPS status.</b> GPS OK (green, accuracy 20 m or better) · GPS WEAK (orange) · SEARCHING GPS · GPS LOST (no update for 12 s) · NO GPS · DEMO GPS.'],
            ['2', '<b>Speed</b> in km/h (or mph).'],
            ['3', '<b>Data boxes.</b> Tap any box to choose what it shows (see the table below).'],
            ['4', '<b>Your coordinates</b> in the format chosen in Settings.'],
            ['5', '<b>Recording status</b>: Not recording / Recording trip with distance / Paused.'],
            ['6', '<b>Toolbar</b>: Record, Mark, Go To, TrackBack, Search, Trips, Maps, Settings (Settings &amp; tools).'],
            ['7', '<b>Map buttons</b>: compass (north-up / track-up), 3D, map view, zoom in/out, ☾ night-vision screen, follow me ◎.'],
            ['8', '<b>Pitch and roll gauges</b> (only when the unit has a motion sensor).'],
            ['9', '<b>Your car</b> — your own Land Cruiser icon, pointing the way you are driving. Choose an arrow instead in Settings.']], [1, 15.8]),
       P('On a phone', h2),
       side(IMG('phone-main.jpg'), 4.6, [P('Phones get a simpler screen built around how you drive:', body)] + B([
           '<b>Top strip</b>: speed, two data boxes of your choice, GPS status.',
           '<b>Five big buttons</b> at the bottom: <b>Record</b>, <b>Mark</b>, <b>Go To</b>, <b>Trips</b> and <b>More</b> (TrackBack, Search, Maps, Emergency, Weather, Settings &amp; tools).',
           'Map buttons on the right: compass, map view, ☾ night-vision and follow-me. Zoom with two fingers.',
           'Everything stays clear of Android’s status bar and navigation buttons.']), 12.2),
       Spacer(1, 6),
       side(IMG('phone-more.jpg'), 4.6, [P('Hide the buttons', h3), P('<b>Tap the map once</b> to hide the buttons and see more map; <b>tap again</b> to bring them back. Taps on waypoints and places, long-press, drag, pinch and double-tap zoom work as before. Navigation and warnings stay visible. This works on the car screen too — the map widens when the toolbar hides.', body)], 12.2),
       P('Gestures', h2)] + B([
       '<b>Drag</b> to move the map (Rimal stops following you; tap ◎ to follow again).',
       '<b>Pinch</b> to zoom, <b>two-finger twist</b> to rotate, <b>two-finger drag up/down</b> to tilt in 3D.',
       '<b>Long-press</b> anywhere (or right-click) to see that point: coordinates, distance and bearing from you, elevation, with <b>Go here</b> and <b>Save</b>.',
       '<b>Tap a waypoint or place</b> on the map to open it.']) + [
       P('What the data boxes can show', h2),
       tbl([['Choice', 'Shows', 'Choice', 'Shows'],
            ['Heading', 'Direction of travel, e.g. 111° ESE', 'Sunrise / Sunset', 'Today’s times; sunset counts down in the last 4 h'],
            ['Altitude', 'GPS altitude', 'Pitch / Roll', 'Vehicle angles'],
            ['Ground elev', 'Terrain height under you (from the terrain pack)', 'Fuel range', 'Range left since your last fill-up'],
            ['Trip', 'Distance of the current recording', 'To target / ETA', 'While navigating'],
            ['Moving time', 'Time spent moving', 'Temp, Wind / gusts', 'From the saved forecast'],
            ['Avg moving / Max speed', 'Trip speeds', 'Position', 'Coordinates'],
            ['Odometer', 'Total distance driven with Rimal', 'GPS accuracy, Time', '±metres; clock']], [3.2, 5.2, 3.2, 5.2]),
       PageBreak()]

# ---------------- 5 map views
st += [P('5. Map views and layers', h1),
       side(UI + 'maps-view.jpg', 8.2, [P('Open <b>Maps</b> on the toolbar. The <b>View</b> tab has:', body)] + B([
           '<b>Map view</b>: <i>Satellite + roads</i> (default, imagery with roads, tracks and names), <i>Satellite only</i>, or <i>Topo map</i> (drawn map with terrain).',
           '<b>3D terrain</b>, <b>Terrain shading</b> (hillshade) and <b>Contour lines</b> (100 m down to 5 m depending on zoom).',
           '<b>Imagery brightness / opacity</b>.',
           '<b>Colours</b>: Day or Night (darker map).',
           '<b>Map labels</b>: English or Arabic.'])),
       Spacer(1, 8),
       P('The ◧ map button cycles Satellite + roads → Satellite only → Topo. The <b>3D</b> button tilts the terrain; tilt with two fingers.'),
       Table([[Image(IMG('topo.jpg'), 8.2 * cm, 8.2 * cm * 720 / 1280), Image(IMG('tracks.jpg'), 8.2 * cm, 8.2 * cm * 720 / 1280)]], colWidths=[8.4 * cm, 8.4 * cm]),
       P('Left: Topo view with contour lines (Tuwaiq escarpment). Right: desert tracks from the map drawn as orange dashes (Red Sands).', caption),
       P('Desert tracks', h2),
       P('Tracks mapped in OpenStreetMap (“highway=track”) are drawn as bright orange dashes on top of the imagery so they stand out on sand. Turn this off in Settings (“Highlight desert tracks”).'),
       P('Imagery sources', h2),
       P('<b>Maps → Satellite &amp; areas → Satellite imagery source</b>: <i>Sentinel-2 cloudless</i> (default; free, 10 m, whole country, cloud-free), <i>Esri World Imagery</i> (sub-metre in many places; personal use only) or a <i>Custom URL</i>. “Keep every tile I view online” saves what you look at, so places you have browsed stay sharp offline.'),
       P('Lite mode (faster car screens)', h2),
       P('Settings → <b>Lite mode</b> draws fewer labels, turns off contours and 3D, and draws at a lower resolution. It is on by default because car screens have slow graphics chips. On a phone you can turn it off for a richer map.'),
       PageBreak()]

# ---------------- 6 trips
st += [P('6. Recording trips', h1),
       P('Starting a recording', h2),
       P('Rimal records <b>only when you tap Record</b>. If you prefer it to start by itself whenever the car moves, turn on <b>Auto-record</b> in Settings. If Rimal was closed while recording, the drive is saved automatically the next time it starts (if more than 30 minutes have passed) so no old line is carried into a new trip.'),
       P('Recording by hand', h2),
       side(UI + 'rec.jpg', 8.2, B(['Tap <b>Record</b> to start a new trip, or to add today’s driving to an existing trip (multi-day expeditions).',
                                    'While recording, tap the red <b>Trip</b> button: <b>Pause / Resume</b>, <b>Stop &amp; save trip</b> (you can name it), or <b>Discard</b>.',
                                    'GPS dropouts longer than 2 minutes or jumps over 1 km start a new leg, so there is never a straight line across a gap.']), 8.2),
       Spacer(1, 6),
       P('GPS accuracy: snap to roads and learned correction', h2),
       P('Car-screen GPS receivers are often 20–40 m off, which puts the track over houses or cuts across roundabouts. Rimal corrects this with the offline street map, with no internet needed:'),
       ] + B(['<b>Snap to roads</b>: on streets, each position is placed on the nearest road that runs in the direction you are driving. Off-road, nothing is snapped.',
              '<b>Learn and correct GPS error</b>: every snapped position measures how far the GPS is off. After a few minutes on streets with turns, Rimal knows the error (for example “22 m to the west”) and corrects every position with it — also in the desert where there is no road to snap to. The correction is relearned continuously and is dropped 30 minutes after you leave the roads, because GPS error drifts as the satellites move.',
              'Settings → <b>GPS accuracy</b> shows the current correction. A better antenna position, or a phone or USB GPS, still gives the biggest improvement.']) + [
       P('Your trips library', h2),
       P('<b>Trips</b> on the toolbar has four tabs: <b>Trips</b> (recorded), <b>Routes</b> (planned), <b>Imported</b> and <b>Waypoints</b>. Open a trip to see:'),
       ] + B(['Distance, moving time, total time, average and maximum speed, climb, number of legs.',
              'An <b>elevation profile</b> of the whole drive.',
              'Name and notes (who came, conditions, where you camped…).',
              'Buttons: <b>Show on map</b>, <b>TrackBack</b>, <b>Follow</b>, <b>Continue this trip next time</b>, show/hide on map, <b>Export GPX</b>, <b>Delete</b>.']) + [
       Table([[Image(IMG('recording.jpg'), 8.2 * cm, 8.2 * cm * 720 / 1280), Image(IMG('trackback.jpg'), 8.2 * cm, 8.2 * cm * 720 / 1280)]], colWidths=[8.4 * cm, 8.4 * cm]),
       P('Left: recording a trip (red line). Right: TrackBack guiding back to the start along the trip (pink).', caption),
       P('Waypoints', h2)] + B([
       '<b>Mark</b> on the toolbar saves your current position instantly (camp, well, soft sand, a good dune).',
       'Long-press the map → <b>Save</b> to mark any other point.',
       'Edit a waypoint for its name, notes, colour and a <b>proximity alert</b>: choose a radius and Rimal beeps and shows a warning when you come within it — useful for hazards, soft sand, fences or a camp entrance.']) + [PageBreak()]

# ---------------- 7 navigation
st += [P('7. Navigating', h1),
       side(UI + 'goto.jpg', 8.2, [P('<b>Go To</b>', h3)] + B([
           'Type or paste coordinates in almost any format: decimal (24.7136, 46.6753), degrees-minutes (N24 42.816 E46 40.518), degrees-minutes-seconds, UTM, or a Google Maps link. Then <b>Navigate</b>, <b>Save as waypoint</b> or <b>Show on map</b>.',
           '<b>Project a point</b>: a bearing and distance from where you are (e.g. 230°, 12 km).',
           'Or pick one of your waypoints.'])),
       Spacer(1, 6),
       box('Go To is a straight line', 'Go To and the magenta line point <b>directly</b> at the target, the way off-road GPS units do — they do not follow streets, and in town the line crosses houses and hills. Use it for the desert; for streets use TrackBack, a saved route, or the route planner. Turn-by-turn routing along roads is on the roadmap (it needs a road-routing pack of its own).'),
       P('While navigating', h2),
       P('A bar at the top shows the target, <b>distance</b>, <b>bearing</b> (and compass direction), <b>ETA</b> and, on routes, how far <b>off track</b> you are. A magenta line leads from your car to the target. Tap ✕ to stop.'),
       ] + B(['<b>Arrival</b>: a beep and message when you are within the arrival radius (Settings: 25–250 m).',
              '<b>Off-track alarm</b>: when following a route or trip, a warning if you stray further than the chosen distance (50–500 m).']) + [
       P('Voice guidance', h2),
       P('Settings → <b>Voice guidance</b>. Rimal speaks when navigation starts (target, distance and direction), at 20, 10, 5, 2 and 1 km, 500, 200 and 100 m, when you arrive, go off track, and for every warning (speed, sunset, heat, fuel, waypoint alerts). It uses the phone’s or car screen’s own text-to-speech voice, so it needs no download and no extra space. Tap <b>Test voice</b> to hear it; if nothing is heard, install or enable “Speech Services by Google” in Android settings.'),
       P('TrackBack and Follow', h2),
       P('<b>TrackBack</b> on the toolbar: <b>Back to start</b> retraces the trip you are recording right now; or choose any saved trip and go <b>Back</b> along it, or <b>Follow</b> it forwards. This is the safest way out of dunes — you return exactly the way you came.'),
       P('Route planner and measuring', h2),
       P('<b>Settings &amp; tools → Route planner</b>: tap points on the map to build a route (shows each leg and the total), <b>Undo</b> the last point, <b>Save</b> it to Routes, or <b>Go</b> to follow it now. <b>Measure</b> works the same way for checking distances.'),
       P('Search', h2),
       side(UI + 'search.jpg', 8.2, B(['Search towns, places and fuel stations by name (English or Arabic), or type coordinates.',
                                       'Tap a category for the <b>nearest</b> fuel, water/wells, camping, mechanics/tyres, hospitals, police, food/shops, mosques, towns or sights — all from the offline places pack.',
                                       '“Show POIs on the map” draws them as coloured dots.'])),
       PageBreak()]

# ---------------- 8 safety
st += [P('8. Safety tools', h1),
       P('All tools are under <b>Settings &amp; tools</b> on the toolbar.'),
       img(UI + 'tools.jpg', 11, 'Settings & tools.'),
       P('Emergency (SOS)', h2),
       side(UI + 'sos.jpg', 8.2, B(['Your position in large text in three formats, altitude, accuracy, and the direction and distance to the nearest town — ready to read to an operator.',
                                    'Buttons: call <b>911</b>, <b>Red Crescent 997</b>, <b>Send location by SMS</b> (works with very weak signal), <b>Save this spot</b>.'])),
       P('Weather and heat', h2)] + B([
       'Current temperature, sky, wind, gusts and visibility, and the next days. Fetched whenever the unit is online and <b>kept for offline use</b> (the age is shown).',
       'Strong gusts (over 50 km/h) show a blowing-sand warning.',
       '<b>Extreme-heat warning</b>: at 45 °C and above (or 47 °C forecast) an alert reminds you to keep revs low, watch the coolant and carry extra water.']) + [
       P('Alerts', h2),
       tbl([['Alert', 'When', 'Set in'],
            ['Speed', 'Above your limit (60–140 km/h)', 'Settings → Speed alert'],
            ['Sunset', '45 minutes before sunset', 'Sun & time'],
            ['Low fuel', 'Under 60 km of range, or not enough to reach the nearest station', 'Fuel range'],
            ['Waypoint proximity', 'Within the radius you set for a waypoint', 'Edit waypoint'],
            ['Pitch / roll', 'Vehicle angle beyond your limit (20–40°)', 'Pitch & roll'],
            ['Off track / arrival', 'While navigating', 'Settings'],
            ['Heat', '45 °C and above', 'Settings → Heat warning']], [3.6, 7.6, 5.6]),
       Spacer(1, 6),
       P('Fuel range', h2),
       P('Enter your range on a full tank; tap <b>I just filled up</b> after refuelling. Rimal counts down the range, finds the nearest stations, and draws two rings: <b>orange</b> = turn-back radius (half the range), <b>red</b> = full range (as the crow flies). Use the fuel log (section 9) to measure your real range.'),
       P('Pitch and roll', h2),
       P('Live gauges of the vehicle’s nose up/down and side tilt with warning limits. Rimal levels itself at start-up; for best accuracy park on level ground and press <b>Calibrate</b>. Many car screens have no motion sensor — then the gauges stay hidden.'),
       P('Sun and time', h2),
       P('First light, sunrise, sunset, last light, daylight left and tomorrow’s sunrise for where you are.'),
       PageBreak()]

# ---------------- 9 trip tools
st += [P('9. Trip tools', h1),
       P('Trip checklist', h2),
       side(UI + 'checklist.jpg', 7.4, B(['Ready-made list for desert trips: vehicle, recovery gear, water and food, safety and comms, navigation and camping.',
                                          'Rimal ticks its own items: offline maps installed, weather saved, GPS fix.',
                                          '<b>Water calculator</b>: people × days → litres to carry (5 L per person per day, 8 L in heat, plus a spare day).',
                                          'Add your own items; <b>Untick all</b> before each new trip.'])),
       P('Service checklist', h2),
       side(IMG('phone-service.jpg'), 4.6, B(['Routine maintenance for your Land Cruiser: engine oil, filters, tyres, alignment, brakes, coolant, gearbox, transfer case, differentials, propeller-shaft grease, plugs, belts, battery, wipers, AC.',
                                        'Enter the car’s odometer once; Rimal adds the distance you drive with it. Correct it from the dashboard now and then.',
                                        'Tap <b>✓ Done</b> after a service. Items show km and months left, turn amber when due soon and red when overdue, and the most urgent come first.',
                                        'Tap ✎ to set intervals from your service book (the defaults are typical), or add your own items.']), 12.2),
       P('Fuel log', h2),
       side(UI + 'fuellog.jpg', 7.4, B(['Add a fill-up each time you refuel: odometer, litres, price, and whether you filled to the top.',
                                        'After two full tanks Rimal shows your real consumption (L/100 km), the last tank, cost per km and price per litre.',
                                        'Enter your tank size to get your measured range, then <b>Use it for the range rings</b>.'])),
       PageBreak(),
       P('Stargazing', h2),
       side(UI + 'stars.jpg', 7.4, B(['A star rating for tonight, the Moon’s phase and brightness, moonrise and moonset.',
                                      '<b>Fully dark</b>: astronomical night, when the sun is 18° below the horizon.',
                                      '<b>Moon-free dark</b> and the <b>best window</b> to look up.',
                                      'When the <b>Milky Way core</b> is above the horizon in the dark (best March–September).',
                                      'A rating for each of the next 10 nights, to pick a trip date.',
                                      'Save the spot as a stargazing waypoint.'])),
       P('Night-vision screen', h2),
       img(IMG('tints.jpg'), 13.5, 'Red, deep red, amber and green.'),
       ] + B(['The <b>☾</b> button on the map turns it on and off in one tap.',
              'Pick the colour in Settings or Stargazing: <b>Red</b> (best for keeping your eyes adapted to the dark), <b>Deep red</b> (darkest), <b>Amber</b> (easier to read), <b>Green</b> (night-goggle look — not good for dark adaptation).',
              '<b>Extra dimming</b> from None to Max. For the darkest screen also turn the unit’s own brightness down and use Day/Night → Night.']) + [PageBreak()]

# ---------------- 10 import/export
st += [P('10. Importing, exporting and backups', h1),
       P('Import tracks and routes', h2),
       P('<b>Trips → Import GPX / KML / GeoJSON</b>. You can pick several files at once. Accepted: <b>.gpx</b>, <b>.kml</b>, <b>.kmz</b>, <b>.geojson / .json</b> and <b>.zip</b> archives containing any of these.'),
       P('From Gaia GPS', h3)] + S([
       'In Gaia, open a track, route, waypoint or a whole folder → <b>Export</b> → choose GPX (or KML/GeoJSON).',
       'Save it to the phone or a USB stick. A folder export arrives as a .zip — no need to unpack it.',
       'In Rimal: <b>Trips → Import</b> and pick the file(s). Tracks land in <b>Imported</b>, waypoints in <b>Waypoints</b>.']) + [
       P('Export', h2)] + B([
       'Any trip: <b>Export GPX</b>. All trips at once: <b>Trips → Export all (GPX)</b>.',
       'Files are saved to <b>Documents/Rimal</b> on the device (or offered through the share menu).']) + [
       P('Backup and restore', h2),
       P('<b>Settings &amp; tools → Backup</b> saves all trips, routes, waypoints and settings in one file in Documents/Rimal. To restore on this or another device: <b>Restore from file</b> (or Trips → Import). Restoring merges — nothing on the device is deleted. Do this before uninstalling or changing car screens. Maps are not part of the backup; keep your USB map files.'),
       P('Sharing with friends', h2),
       P('Friends install the same APK and map files — nothing needs to be made separately. Each device has its own trips and settings; share trips as GPX files. Ask them to choose the <b>Arrow</b> position icon in Settings (the default icon is your own Land Cruiser).'),
       PageBreak()]

# ---------------- 11 activity log
st += [P('11. Activity log and reporting problems', h1),
       side(UI + 'activity.jpg', 8.2, [P('Rimal keeps a <b>flight recorder</b>: a log of the last 14 days on the device only. It records taps and screens opened, GPS quality and dropouts, map and download problems, navigation, recordings, freezes, speed of the app (frame rate), memory, battery and every error. Nothing is sent anywhere.', body)]),
       P('When something goes wrong', h2)] + S([
       'Tap <b>Settings &amp; tools → Flag issue</b> right away and type a few words (“map froze”, “GPS jumped”). The position and what the app was doing are saved with it.',
       'Later, open <b>Activity log</b>. Each session (each time the app was started) shows its events, errors, warnings and flagged issues. <b>View</b> shows the key events.',
       'Tap <b>Export all</b> (or the download arrow next to one session). A text file is saved to <b>Documents/Rimal</b>.',
       'Or tap <b>📤 Send…</b> to send the log straight from the share menu — Bluetooth to your phone, WhatsApp, email or Google Drive.',
       'Send that file to Claude for analysis.']) + [
       P('User manual in the app', h2),
       P('<b>Settings &amp; tools → User manual</b> opens the latest version of this manual. It is published with every app update in the same place as the app, so it always matches your version.'),
       P('Test report', h2),
       P('<b>Settings &amp; tools → Test report</b> creates a one-page summary of the device, screen, graphics chip, GPS quality (first fix, accuracy, gaps), sensors, installed maps, storage, start-up speed and recent errors. Add a short note and send the file along with the activity log.'),
       P('Demo GPS', h2),
       P('Settings → <b>Demo GPS</b> simulates a drive so you can try navigation and recording indoors. The status shows DEMO GPS. Remember to turn it off.'),
       PageBreak()]

# ---------------- 12 settings
st += [P('12. Settings reference', h1),
       tbl([['Setting', 'Options', 'Notes'],
            ['Units', 'Metric / Imperial', 'km, m, km/h or mi, ft, mph'],
            ['Coordinate format', 'Decimal · Deg Min · DMS · UTM', 'Used everywhere positions are shown'],
            ['Off-track alarm', '50 / 100 / 200 / 500 m', 'While following a route'],
            ['Arrival radius', '25 / 50 / 100 / 250 m', ''],
            ['Speed alert', 'Off, 60–140 km/h', ''],
            ['Track detail', 'High 3 m · Normal 8 m · Low 20 m', 'Spacing between recorded points'],
            ['Position icon', 'My Land Cruiser · Arrow', ''],
            ['Night-vision screen', 'On/off, colour, dimming', 'Also the ☾ button'],
            ['Lite mode', 'On / off', 'Faster on car screens'],
            ['Highlight desert tracks', 'On / off', 'Orange dashes'],
            ['Heat warning', 'On / off', '45 °C and above'],
            ['Activity recorder', 'On / off', 'Bug-finding log (on by default)'],
            ['Auto-record', 'Off (default) / on', 'Start a trip by itself when moving'],
            ['Voice guidance', 'On / off, Test voice', 'Spoken distances, arrival and warnings'],
            ['Snap to roads', 'On (default) / off', 'Keeps position and track on streets'],
            ['Learn and correct GPS error', 'On (default) / off', 'Learned on roads, used everywhere'],
            ['Demo GPS', 'On / off', 'Simulated drive'],
            ['Maps → View', 'Map view, 3D, hillshade, contours, brightness, Day/Night, labels', 'Section 5'],
            ['Maps → Satellite & areas', 'Imagery source, keep viewed tiles, download area', 'Section 3.4'],
            ['Maps → Updates & files', 'Automatic updates, check now, import from USB, installed files', 'Section 3']], [4.4, 6.6, 5.8]),
       PageBreak()]

# ---------------- 13 troubleshooting
st += [P('13. Troubleshooting', h1),
       tbl([['Problem', 'What to do'],
            ['“NO GPS” or “SEARCHING GPS”', 'Check Location is allowed for Rimal and the car is outside. Test with a GPS test app: if it also finds nothing, the problem is the car screen’s antenna or GPS. Restarting the car screen (reset button) has fixed it before. Put the antenna on top of the dashboard near the windscreen, away from metal. A USB GPS receiver (for example VK-162) is a cheap fix for a weak built-in GPS.'],
            ['GPS keeps dropping (GPS LOST)', 'Same antenna advice. Flag the issue — the activity log records every dropout and its accuracy, which shows whether it is the antenna or the app.'],
            ['Map is blank', 'Install the maps (section 3). With no maps and no internet there is nothing to draw. If the screen says “Web engine too old”, update Android System WebView or Chrome from the Play Store.'],
            ['App is slow to start or move', 'Keep Lite mode on, turn off 3D and contours, and close other apps. The first start after installing maps is the slowest. Send a test report so the start-up timings can be checked.'],
            ['Maps did not download by themselves', 'Maps → Updates & files: set Automatic updates to <b>Any connection</b> (some car screens do not report a hotspot as Wi-Fi), then Check for updates now. Or install by USB.'],
            ['Imagery blurry when zoomed in', 'The country imagery is zoom 13. Download areas in more detail or make a zoom-18 pack (sections 3.4 and 3.5).'],
            ['Import says the file is not a map', 'Use .pmtiles or .json map files. Keep the original file names. Files from other apps (MBTiles) must be converted first.'],
            ['“App not installed” when updating', 'See section 2 — uninstall the old version once (after making a backup).'],
            ['Pitch & roll gauges missing', 'The car screen has no motion sensor. They work on phones and tablets.'],
            ['Track runs beside the road or over houses', 'Keep Snap to roads and Learn GPS error on (Settings → GPS accuracy). Set Track detail to High. Move the GPS antenna to a clear view of the sky. Trips recorded before version 4 are not corrected.'],
            ['The navigation line goes over houses and mountains', 'Go To is a direct line by design (section 7). Follow a saved trip or route for the way along tracks.'],
            ['Rimal does not appear in Android Auto', 'Android Auto only shows apps built for it and approved through the Play Store. Rimal runs as a normal app on Android car screens and phones; Android Auto support is a separate project.'],
            ['App update says it cannot install', 'Allow Rimal to install apps when Android asks. If Android says the app is not installed, follow the one-time step in section 2.']], [4.8, 12.0]),
       P('Need help?', h2),
       P('Flag the issue, export the activity log and a test report, and send both to Claude together with a short description and screenshots if possible.'),
       P('Credits and data', h2),
       P('Map data © OpenStreetMap contributors (ODbL). Imagery: Sentinel-2 cloudless 2024 by EOX IT Services GmbH (contains modified Copernicus Sentinel data); Esri World Imagery © Esri, Maxar, Earthstar Geographics (personal use). Terrain: Mapzen / AWS Open Data terrain tiles. Weather: Open-Meteo.com. Map display: MapLibre, Protomaps.', small),
       P('Rimal is a navigation aid. Always carry a backup (paper map, second device, satellite messenger), tell someone your route, and drive within your and your vehicle’s limits.', small)]

doc = Doc(OUT)
doc.multiBuild(st)
print('ok')
