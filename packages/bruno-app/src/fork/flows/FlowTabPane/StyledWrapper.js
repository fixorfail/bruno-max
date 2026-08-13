import styled from 'styled-components';

const StyledWrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;

  .flow-toolbar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.375rem 1rem;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};

    label {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
  }

  .flow-loading,
  .flow-error {
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .flow-error {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .flow-diagnostics {
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    max-height: 10rem;
    overflow: auto;
  }

  .diagnostic-counts {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 0.25rem;

    .error {
      color: ${(props) => props.theme.colors.text.danger};
    }

    .warning {
      color: ${(props) => props.theme.colors.text.warning};
    }
  }

  .diagnostic {
    display: flex;
    gap: 0.5rem;
    padding: 0.0625rem 0;
    color: ${(props) => props.theme.colors.text.muted};
  }

  .diagnostic.error .diagnostic-code {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .diagnostic.warning .diagnostic-code {
    color: ${(props) => props.theme.colors.text.warning};
  }

  .diagnostic-line {
    margin-left: auto;
  }
`;

export default StyledWrapper;
