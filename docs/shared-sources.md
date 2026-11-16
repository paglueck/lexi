# Sharing style guides and the term base across projects

By default a project keeps its style guides in `.lexi/styleguides/` and its term base in
`.lexi/termbase.csv`. Several projects can share both instead: keep them in a Git repository of
their own, check it out, and link each project to that checkout.

## Layout of the shared repository

The shared files use the same format as the files in `.lexi/`. A typical repository:

```
lexi-shared/
├── termbase.csv          # the term base (format: termbase-csv.md)
└── styleguides/
    ├── global.md         # the global guide
    ├── de.md             # one guide per locale
    └── fr.md
```

Style guides and the term base are linked separately. Each link points to a **folder**: for the
style guides, the folder that holds `global.md` and the locale guides; for the term base, the
folder that holds `termbase.csv`. You can link one without the other.

## Linking a project

On the **Style guides** or **Term Base** screen, choose **Link shared folder…** next to the path in
the toolbar and pick the folder. **Change…** picks a different folder. **Unlink** switches the
project back to its own files.

- **A link replaces the project's own files.** While it is set, Lexi reads from and writes to the
  shared folder only. The files in `.lexi/` stay where they are, untouched, and come back into use
  when you unlink.
- **Edits are written to the shared checkout.** Lexi does not commit or push. Review and commit
  the changes in the shared repository as you would any other change.
- **The link is local to your machine.** It is an absolute path, stored in
  `.lexi/settings.local.json`, which `.lexi/.gitignore` keeps out of Git. Each teammate links their
  own checkout once.
- **The folder must be inside the folders Lexi may access.** This is your home folder and any
  folder passed on the command line.

## Staying in sync

Lexi watches the linked folders. When their files change, for example after a `git pull` in the
shared repository or a save from another project, the screens reload and term checks use the new
terms. Prompts always read the current files.

If you have unsaved edits in a style guide when its file changes on disk, Lexi keeps your edits and
asks before reloading.

## Projects with different locales

Projects that share a term base may have different target locales. On save, Lexi keeps the
existing column order of the shared `termbase.csv` and adds this project's new locales at the end.
Columns for locales this project does not have are kept unchanged.

An old `.lexi/glossary.json` is never migrated into a shared term base.

## When the shared folder is missing

If the linked folder is not there, for example because the repository is not checked out on this
machine, the screen shows **Shared folder missing**. Lexi reads no style guides or terms from it
and refuses to save rather than create the folder. Check out the repository again or unlink.
