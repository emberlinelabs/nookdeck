# Clipboard snippets

No code. Two actions that put a piece of text on the clipboard of the computer, so a phone button can "paste" an email address, a link or a reply.

- **Access it asks for:** run commands on this computer (`shell`). Nothing else: no network.
- **Use it:** add a button, choose the action for your system (macOS or Windows), and type the text in its settings.
- **How the text reaches the command:** a setting is never pasted into the command line (a value with quotes could run as code). Nookdeck gives it to the command as an environment variable, `NOOKDECK_SETTING_TEXT` for the setting `text`, so any text is safe, quotes included.
