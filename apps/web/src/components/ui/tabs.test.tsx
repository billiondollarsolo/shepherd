import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

function Fixture() {
  return (
    <Tabs defaultValue="one">
      <TabsList aria-label="Sections">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two">Two</TabsTrigger>
      </TabsList>
      <TabsContent value="one">Panel one</TabsContent>
      <TabsContent value="two">Panel two</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('exposes the tablist/tab/tabpanel roles and shows the active panel', () => {
    render(<Fixture />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    const [tabOne, tabTwo] = screen.getAllByRole('tab');
    expect(tabOne).toHaveAttribute('aria-selected', 'true');
    expect(tabTwo).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Panel one')).toBeInTheDocument();
    expect(screen.queryByText('Panel two')).not.toBeInTheDocument();
  });

  it('switches the visible panel on click', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Panel two')).toBeInTheDocument();
  });

  it('moves selection with ArrowRight (roving tabindex)', () => {
    render(<Fixture />);
    const tabOne = screen.getByRole('tab', { name: 'One' });
    tabOne.focus();
    fireEvent.keyDown(tabOne, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
  });
});
