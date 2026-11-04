export default function Table({ headings, children }) {
  return <div class="table-responsive"><table class="table table-striped align-middle">
    <thead><tr>{headings.map(heading => <th scope="col" key={heading}>{heading}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}
