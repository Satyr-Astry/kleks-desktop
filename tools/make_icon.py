
from PIL import Image
src = r"E:\dev\klecks\src\app\img\klecks-icon.png"
im = Image.open(src).convert("RGBA")
print("source size", im.size)
sizes = [(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
im.save(r"E:\dev\klecks-desktop\klecks-icon.ico", format="ICO", sizes=sizes)
# also a 512 png for later use / taskbar
im.resize((512,512), Image.LANCZOS).save(r"E:\dev\klecks-desktop\klecks-icon-512.png")
print("ico written")
