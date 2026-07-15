import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
  DialogPortal,
  DialogOverlay,
} from './dialog';

describe('Dialog', () => {
  it('exports Trigger/Close/Portal/Overlay', () => {
    expect(DialogTrigger).toBeDefined();
    expect(DialogClose).toBeDefined();
    expect(DialogPortal).toBeDefined();
    expect(DialogOverlay).toBeDefined();
  });

  it('opens from its trigger and closes from DialogClose', () => {
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent hideClose>
          <DialogTitle>Panel</DialogTitle>
          <DialogClose>Done</DialogClose>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
