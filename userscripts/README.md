# Wikimedia user scripts

## `bwc2026-people-tagger.js` — tag people in Commons photos

Adds the categories under
[Category:People at Bangla WikiConference 2026 by name](https://commons.wikimedia.org/wiki/Category:People_at_Bangla_WikiConference_2026_by_name)
to images with one click.

Putting ~70 names under each of up to 200 images on a category page would mean
about 14,000 buttons. This script builds the name list **once**, in a floating
palette, and leaves only a ☐ checkbox, the people already tagged, and a small
**＋** button under each image.

### Install

1. On Commons, create `User:<you>/BWC2026PeopleTagger.js` and paste the file into it.
2. Add this line to `User:<you>/common.js`:

   ```js
   mw.loader.load('//commons.wikimedia.org/w/index.php?title=User:<you>/BWC2026PeopleTagger.js&action=raw&ctype=text/javascript');
   ```

It starts by itself on category pages and file pages whose title or categories
contain "Bangla WikiConference 2026". On other pages with images, use
**Tools → People tagger**.

### Use

- **One photo at a time:** press **＋** under a photo, type a few letters of a
  name, press **Enter**. Repeat for each person, then press **Enter** on an
  empty box (or **→**) to go to the next photo. The palette shows a large
  preview so you can recognise faces.
- **Many photos at once:** tick ☐ on several photos (Shift-click selects a
  range, **All** selects every photo), then click names. A name is filled in
  if every selected photo has it and half-filled if only some do.
- Names clicked within 2 seconds of each other are saved together, as **one
  edit per photo**.
- Under each photo, an outlined tag is waiting to be saved, a red tag failed
  (click it to retry), and **×** removes a tag (it asks first).
- **Hide tagged** hides photos that already have at least one person.
- **/** anywhere on the page jumps to the name search.

Short names come from the category names. Prefixes like *Md.*, *Mohammad*,
*Syed*, *Dr.*, *A.K.M.* and *মোঃ* are skipped, and two people with the same
first name get an initial (*Rahim K.*, *Rahim U.*). To change a short name or
hide a subcategory, put this **above** the `mw.loader.load` line:

```js
window.bwcPeopleTaggerConfig = {
  labels: { 'Category:Md. Abdullah Al Mamun': 'Mamun' },
  exclude: [ 'Category:Some non-person subcategory' ]
};
```

The people list is cached for an hour. After adding new person categories,
click **⟳** in the palette.
