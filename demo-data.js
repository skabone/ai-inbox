// Fully invented demo mailbox. No real email, people, bookings or Gmail links. Times are relative to when the page opens.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.INBOX_DEMO = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ME = { name: 'Mintay (demo)', email: 'mintay@demo.invalid' };
  const H = 3600000;
  const DONE = 'AI Inbox/Done';
  const TODO = 'AI Inbox/To-do';

  // Each thread: [id, messages]; each message: [hoursAgo, from, to, subject, snippet, labels, extra]
  const SPEC = [
    ['demo-01', [[6, ['Maya Chen', 'maya@studio.demo'], [ME], 'A quick decision on the workshop outline', 'Hi Mintay, Option A has a 20-minute walkthrough and a hands-on exercise; Option B is a 45-minute discussion. Could you choose one by Tuesday? This is an invented demo message.', ['INBOX', 'UNREAD', 'IMPORTANT']]]],
    ['demo-02', [[9, ['Harbor Studio Bookings', 'bookings@harborstudio.demo'], [ME], 'Your room hold ends tomorrow', 'We are holding the Cedar Room for your sample session. Please let us know by tomorrow at 5 PM whether you would like to keep the reservation. Synthetic demo content.', ['INBOX', 'UNREAD']]]],
    ['demo-03', [[11, ['Lena Brooks', 'lena@friends.demo'], [ME], 'Saturday lunch: does noon work?', 'Hey Mintay, would noon on Saturday work for lunch? There is an outdoor table if the weather cooperates. These plans are invented.', ['INBOX']]]],
    ['demo-04', [[130, ['Owen Patel', 'owen@studio.demo'], [ME], 'Revised workshop budget', 'Here is the revised budget for the sample workshop.', ['INBOX']], [100, ME, [['Owen Patel', 'owen@studio.demo']], 'Re: Revised workshop budget', 'Thanks Owen. Can you send the final numbers when the venue confirms?', ['SENT']]]],
    ['demo-05', [[20, ['Sam Rivera', 'sam@neighbors.demo'], [ME], 'Borrowing the ladder', 'Do you still need the ladder this weekend?', ['INBOX']], [8, ME, [['Sam Rivera', 'sam@neighbors.demo']], 'Re: Borrowing the ladder', 'Yes please, Saturday morning works.', ['SENT']]]],
    ['demo-06', [[30, ['PSE Billing', 'billing@pse.demo'], [ME], 'Your energy bill is ready', 'Your sample bill of $84.12 is due Nov 3. Pay online or by phone. Invented demo bill.', ['INBOX', 'UNREAD'], { listUnsubscribe: true }]]],
    ['demo-07', [[26, ['Dr. Anna Lee', 'anna.lee@clinic.demo'], [ME], 'Your appointment next week', 'Hi Mintay, please confirm your appointment on Tuesday at 2 PM, or reply if you need another time. Invented demo message.', ['INBOX', 'IMPORTANT']]]],
    ['demo-08', [[14, ['Parcel Updates', 'no-reply@parcel.demo'], [ME], 'Your package is out for delivery', 'Your sample order is out for delivery and should arrive today.', ['INBOX', 'UNREAD']]]],
    ['demo-09', [[52, ['Cedar Goods', 'orders@cedargoods.demo'], [ME], 'Receipt for your order #4821', 'Thanks for your purchase of a sample notebook set. Invented receipt.', ['INBOX']]]],
    ['demo-10', [[72, ['Skyway Air', 'no-reply@skyway.demo'], [ME], 'Itinerary: Seattle to Portland', 'Your sample flight departs Friday at 8:15 AM. Confirmation code DEMO42.', ['INBOX']]]],
    ['demo-11', [[40, ['Neighborhood Council', 'events@council.demo'], [ME], 'You are invited: fall potluck', 'Join the sample fall potluck at the park pavilion. Please RSVP by Friday.', ['INBOX', 'UNREAD']]]],
    ['demo-12', [[60, ['Cedar Library', 'news@cedarlibrary.demo'], [ME], 'New arrivals this month', 'Browse the sample reading list for November.', ['INBOX'], { listUnsubscribe: true }]]],
    ['demo-13', [[90, ['Jordan Kim', 'jordan@studio.demo'], [ME], 'Slides for Thursday', 'Can you look over the sample slides before Thursday?', ['INBOX', DONE]]]],
    ['demo-14', [[120, ['Priya Shah', 'priya@studio.demo'], [ME], 'Room setup notes', 'Could you share the room setup notes?', ['INBOX', DONE]], [5, ['Priya Shah', 'priya@studio.demo'], [ME], 'Re: Room setup notes', 'One more thing: what time should the chairs be ready?', ['INBOX', 'UNREAD']]]],
    ['demo-15', [[48, ['Alex Moreno', 'alex@friends.demo'], [ME], 'Photos from the hike', 'Here are the sample photos from the hike. No rush to look.', ['INBOX', 'STARRED']]]],
    ['demo-16', [[18, ['Riley Tran', 'riley@studio.demo'], [['Team list', 'team@studio.demo']], 'Team update', 'Quick sample update for everyone. Any questions?', ['INBOX'], { cc: [ME] }]]],
    ['demo-18', [[34, ['Riverside College', 'no-reply@college.demo'], [ME], 'Winter quarter class schedule posted', 'The sample winter quarter schedule is now available in the student portal.', ['INBOX', 'UNREAD']]]],
    ['demo-19', [[66, ['Evergreen Bank', 'statements@evergreen.demo'], [ME], 'Your October statement is ready', 'Your sample statement is ready. Autopay is on, so no action is needed.', ['INBOX'], { listUnsubscribe: true }]]],
    ['demo-17', [[80, ['Hana Ito', 'hana@friends.demo'], [ME], 'Book recommendation', 'Thought you might like this invented novel.', ['INBOX', TODO]]]]
  ];

  const addr = a => Array.isArray(a) ? { name: a[0], email: a[1] } : a;
  function build(now = Date.now()) {
    const threads = SPEC.map(([id, msgs]) => ({
      id,
      messages: msgs.map(([hoursAgo, from, to, subject, snippet, labels, extra = {}], i) => ({
        id: `${id}-m${i + 1}`,
        threadId: id,
        labelIds: labels.slice(),
        date: now - hoursAgo * H,
        from: addr(from),
        to: to.map(addr),
        cc: (extra.cc || []).map(addr),
        replyTo: null,
        subject,
        snippet,
        messageId: `<${id}-m${i + 1}@demo.invalid>`,
        references: i ? `<${id}-m1@demo.invalid>` : '',
        listUnsubscribe: !!extra.listUnsubscribe,
        body: null
      }))
    }));
    return { me: ME.email, threads };
  }
  return { build, ME };
});
