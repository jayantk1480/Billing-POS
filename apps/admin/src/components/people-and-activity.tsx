'use client';

import { Badge, Card, CardHeader, EmptyState, formatDateTime, Table, Td, Th, useSorted } from '@pos/ui';
import type { PlatformRestaurantDetailDto } from '@pos/validation';
import { History, Users } from 'lucide-react';
import { activityActor, activityLabel } from '@/lib/labels';

export function PeopleCard({ people }: { people: PlatformRestaurantDetailDto['people'] }) {
  const sorted = useSorted(people, {
    name: (person) => person.name, email: (person) => person.email, role: (person) => person.roleName,
    active: (person) => person.isActive, lastLogin: (person) => person.lastLoginAt,
  });
  return (
    <Card>
      <CardHeader title="People" description="Everyone with an account at this restaurant." />
      {people.length === 0 ? (
        <EmptyState icon={Users} title="No accounts" description="This restaurant has no user accounts." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th sorter={sorted.sorter} sortKey="name">Name</Th>
              <Th sorter={sorted.sorter} sortKey="email">Email</Th>
              <Th sorter={sorted.sorter} sortKey="role">Role</Th>
              <Th sorter={sorted.sorter} sortKey="active">Active</Th>
              <Th sorter={sorted.sorter} sortKey="lastLogin">Last sign-in</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.rows.map((person) => (
              <tr key={person.id} className="hover:bg-canvas/50">
                <Td className="font-medium text-ink-900">{person.name}</Td>
                <Td>{person.email}</Td>
                <Td>{person.roleName}</Td>
                <Td><Badge tone={person.isActive ? 'ok' : 'neutral'}>{person.isActive ? 'Active' : 'Switched off'}</Badge></Td>
                <Td className="whitespace-nowrap">{formatDateTime(person.lastLoginAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function ActivityCard({ activity }: { activity: PlatformRestaurantDetailDto['activity'] }) {
  // Newest first, whatever order the entries arrive in.
  const entries = [...activity].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Card>
      <CardHeader title="Recent activity" description="From the restaurant's audit log. It shows what was done and by whom, not bills or customer data." />
      {entries.length === 0 ? (
        <EmptyState icon={History} title="Nothing yet" description="Nothing has been recorded for this restaurant." />
      ) : (
        <ul className="divide-y divide-line">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${entry.action}-${index}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-2.5 text-sm">
              <span className="min-w-0">
                <span className="font-medium text-ink-900">{activityLabel(entry.action)}</span>
                <span className="text-ink-500"> · {activityActor(entry)}</span>
                {entry.reason && <span className="block break-words text-xs text-ink-700">{entry.reason}</span>}
              </span>
              <time dateTime={entry.at} className="whitespace-nowrap text-xs text-ink-500">{formatDateTime(entry.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
