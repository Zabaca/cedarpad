import { Button, Modal } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Capture } from "./Capture.js";

type Kind = "observation" | "problem";

/**
 * Wraps {@link Capture} in a modal. The view renders a trigger button instead of
 * an always-on form; the modal closes itself once a submit succeeds (via `onDone`).
 */
export function CaptureModal({ defaultKind = "observation" }: { defaultKind?: Kind }) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <>
      <Button onClick={open} flex={1}>
        {defaultKind === "problem" ? "New problem" : "New observation"}
      </Button>
      <Modal opened={opened} onClose={close} title="Capture" size="xl">
        <Capture defaultKind={defaultKind} onDone={close} />
      </Modal>
    </>
  );
}
