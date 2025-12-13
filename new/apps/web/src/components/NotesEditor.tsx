import { useEffect } from "react";
import { Button, Group, Text } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { RichTextEditor } from "@mantine/tiptap";
import Link from "@tiptap/extension-link";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import classes from "./NotesEditor.module.css";

export function NotesEditor(props: { storageKey: string; placeholder?: string }) {
  const [value, setValue] = useLocalStorage<string>({ key: props.storageKey, defaultValue: "" });

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false })],
    content: value || "<p></p>",
    onUpdate: ({ editor }) => setValue(editor.getHTML())
  });

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: { attributes: { class: classes.content, "data-placeholder": props.placeholder ?? "" } }
    });
  }, [editor, props.placeholder]);

  if (!editor) {
    return (
      <div className={classes.root} style={{ padding: 16 }}>
        <Text c="dimmed" size="sm">
          Loading editor…
        </Text>
      </div>
    );
  }

  return (
    <div className={classes.root}>
      <RichTextEditor editor={editor}>
        <RichTextEditor.Toolbar sticky stickyOffset={64}>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Bold />
            <RichTextEditor.Italic />
            <RichTextEditor.Strikethrough />
            <RichTextEditor.Code />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup>
            <RichTextEditor.H1 />
            <RichTextEditor.H2 />
            <RichTextEditor.H3 />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup>
            <RichTextEditor.BulletList />
            <RichTextEditor.OrderedList />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Blockquote />
            <RichTextEditor.Hr />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Link />
            <RichTextEditor.Unlink />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Undo />
            <RichTextEditor.Redo />
          </RichTextEditor.ControlsGroup>
        </RichTextEditor.Toolbar>

        <RichTextEditor.Content mih={160} />
      </RichTextEditor>

      <Group justify="space-between" px="md" py="sm">
        <Text size="xs" c="dimmed">
          Saved locally in this browser.
        </Text>
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          onClick={() => {
            editor.commands.setContent("<p></p>");
            setValue("");
          }}
        >
          Clear
        </Button>
      </Group>
    </div>
  );
}

